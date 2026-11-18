"""JSON adapter for the existing dataset and trained pipeline; Streamlit remains optional."""
from __future__ import annotations

import csv
import io
import json
import logging
import os
import warnings
from functools import lru_cache
from pathlib import Path
from threading import Lock
from typing import Literal

os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")

import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from sklearn.exceptions import InconsistentVersionWarning
from starlette.concurrency import run_in_threadpool

ROOT = Path(__file__).resolve().parent
MAX_CSV_BYTES = 5 * 1024 * 1024
MAX_BATCH_ROWS = 10000
logger = logging.getLogger("analytics")


class PredictionInput(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    indoor_temp_c: float = Field(ge=10, le=50)
    indoor_humidity: float = Field(ge=0, le=100)
    outdoor_temp_c: float = Field(ge=-20, le=60)
    outdoor_humidity: float = Field(ge=0, le=100)
    occupancy_count: int = Field(ge=0, le=20)
    target_temp_c: int = Field(ge=16, le=30)
    hour_of_day: float = Field(ge=0, lt=24)
    motion_detected: Literal[0, 1]
    ac_power_state: Literal[0, 1]
    weather_condition: Literal["Clear", "Clouds", "Rain", "Thunderstorm"]
    fan_speed: Literal["Low", "Medium", "High", "Auto", "Off"]
    temp_delta: float | None = None

    @field_validator("weather_condition", "fan_speed", mode="before")
    @classmethod
    def normalize_category(cls, value):
        return value.strip().title() if isinstance(value, str) else value

    def features(self) -> dict:
        result = self.model_dump()
        result["temp_delta"] = round(self.indoor_temp_c - self.target_temp_c, 4)
        return result


@lru_cache(maxsize=4)
def read_frame(path: str, modified: int) -> pd.DataFrame:
    return pd.read_csv(path)


@lru_cache(maxsize=2)
def read_model(path: str, modified: int):
    # Only the repository's local artifact is loaded; clients can upload CSV only.
    with warnings.catch_warnings():
        warnings.simplefilter("error", InconsistentVersionWarning)
        return joblib.load(path)


class AnalyticsService:
    def __init__(self, directory: Path = ROOT):
        self.directory = directory
        self.predict_lock = Lock()

    def frame(self, relative: str) -> pd.DataFrame:
        path = self.directory / relative
        try:
            return read_frame(str(path), path.stat().st_mtime_ns)
        except (OSError, ValueError, pd.errors.ParserError) as error:
            raise HTTPException(503, "Data analitik belum tersedia.") from error

    def model(self):
        path = self.directory / "models/ac_power_regressor.joblib"
        try:
            return read_model(str(path), path.stat().st_mtime_ns)
        except Exception as error:
            logger.warning("Model unavailable: %s", type(error).__name__)
            raise HTTPException(503, "Model prediksi belum siap. Periksa artefak dan versi dependensi layanan analitik.") from error

    def evaluation(self) -> dict | None:
        try:
            metadata = json.loads((self.directory / "models/model_metrics.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return {
            "name": metadata.get("champion_model"),
            "trained_at": metadata.get("timestamp"),
            "training_samples": metadata.get("training_samples"),
            "test_samples": metadata.get("test_samples"),
            "metrics": metadata.get("champion_metrics", {}),
            "benchmarks": [{"name": name, **values} for name, values in metadata.get("all_model_benchmarks", {}).items()],
        }

    def summary(self, days: int | None = None) -> dict:
        frame = self.frame("data/climate_telemetry_100k.csv").copy()
        required = {"timestamp", "ac_power_consumption_w", "ac_power_state", "indoor_temp_c", "outdoor_temp_c", "occupancy_count"}
        if not required.issubset(frame.columns) or frame.empty:
            raise HTTPException(503, "Dataset analitik kosong atau kolomnya tidak lengkap.")
        frame["timestamp"] = pd.to_datetime(frame["timestamp"], errors="coerce")
        if frame["timestamp"].isna().any():
            raise HTTPException(503, "Waktu pada dataset analitik tidak valid.")
        frame = frame.sort_values("timestamp")
        intervals = frame["timestamp"].diff().dt.total_seconds()
        positive = intervals[intervals > 0]
        interval = float(positive.median()) if len(positive) else 60.0
        total_rows = len(frame)
        if days is not None:
            frame = frame[frame["timestamp"] > frame["timestamp"].max() - pd.Timedelta(days=days)]
        numeric_columns = list(required - {"timestamp"})
        for column in numeric_columns:
            frame[column] = pd.to_numeric(frame[column], errors="coerce")
        if not np.isfinite(frame[numeric_columns].to_numpy()).all():
            raise HTTPException(503, "Dataset mengandung pembacaan angka yang tidak valid.")
        frame["hour"] = frame["timestamp"].dt.hour
        hourly = frame.groupby("hour").agg(
            power_w=("ac_power_consumption_w", "mean"),
            indoor_temp_c=("indoor_temp_c", "mean"),
            outdoor_temp_c=("outdoor_temp_c", "mean"),
            active_percent=("ac_power_state", "mean"),
            count=("ac_power_state", "size"),
        ).reset_index()
        hourly["active_percent"] *= 100
        occupancy = []
        for name, mask in [
            ("Tanpa penghuni", frame["occupancy_count"] == 0),
            ("1–3 orang", frame["occupancy_count"].between(1, 3)),
            ("4+ orang", frame["occupancy_count"] >= 4),
        ]:
            occupancy.append({"label": name, "records": int(mask.sum()),
                              "power_w": round(float(frame.loc[mask, "ac_power_consumption_w"].mean()), 2) if mask.any() else None})
        try:
            self.model()
            model_ready = True
        except HTTPException:
            model_ready = False
        return {
            "dataset": {"source": "synthetic", "rows": len(frame), "total_rows": total_rows,
                        "start": frame["timestamp"].min().isoformat(), "end": frame["timestamp"].max().isoformat(),
                        "sample_interval_seconds": interval},
            "metrics": {"average_power_w": round(float(frame["ac_power_consumption_w"].mean()), 2),
                        "active_percent": round(float(frame["ac_power_state"].mean() * 100), 2),
                        "energy_kwh": round(float(frame["ac_power_consumption_w"].sum() * interval / 3600000), 4),
                        "average_indoor_c": round(float(frame["indoor_temp_c"].mean()), 2),
                        "average_outdoor_c": round(float(frame["outdoor_temp_c"].mean()), 2)},
            "hourly": json.loads(hourly.round(3).to_json(orient="records")),
            "occupancy": occupancy,
            "model_ready": model_ready,
            "evaluation": self.evaluation(),
        }

    def predict(self, rows: list[PredictionInput]) -> np.ndarray:
        pipeline = self.model()
        with self.predict_lock:
            predictions = pipeline.predict(pd.DataFrame([row.features() for row in rows]))
        if not np.isfinite(predictions).all():
            raise HTTPException(503, "Model tidak menghasilkan prediksi yang valid.")
        return np.maximum(0, predictions).round(2)

    def batch(self, contents: bytes) -> dict:
        try:
            text = contents.decode("utf-8-sig")
            header = next(csv.reader(io.StringIO(text)))
            if len(header) != len(set(header)):
                raise ValueError("Kolom CSV tidak boleh berulang.")
            frame = pd.read_csv(io.StringIO(text), nrows=MAX_BATCH_ROWS + 1)
            if frame.empty:
                raise ValueError("CSV tidak memiliki baris data.")
            if len(frame) > MAX_BATCH_ROWS:
                raise ValueError(f"Maksimal {MAX_BATCH_ROWS} baris per CSV.")
            required = set(PredictionInput.model_fields) - {"temp_delta"}
            missing = required - set(frame.columns)
            if missing:
                raise ValueError("Kolom CSV belum lengkap: " + ", ".join(sorted(missing)))
            rows = []
            for index, values in enumerate(frame.to_dict(orient="records")):
                try:
                    rows.append(PredictionInput.model_validate({key: values[key] for key in required}))
                except ValidationError as error:
                    field = ", ".join(str(issue["loc"][0]) for issue in error.errors())
                    raise ValueError(f"Baris {index + 2}: nilai tidak valid pada {field}.") from error
        except (ValueError, UnicodeError, StopIteration, pd.errors.ParserError) as error:
            raise HTTPException(422, str(error) or "CSV tidak dapat dibaca.") from error
        predictions = self.predict(rows)
        frame["temp_delta"] = [row.features()["temp_delta"] for row in rows]
        frame["predicted_power_w"] = predictions
        # Prevent CSV spreadsheet formulas in unrelated, user-supplied text columns.
        for column in frame.select_dtypes(include=["object", "string"]).columns:
            frame[column] = frame[column].map(lambda value: "'" + value if isinstance(value, str) and value.startswith(("=", "+", "-", "@")) else value)
        return {"row_count": len(frame), "average_power_w": round(float(predictions.mean()), 2),
                "preview": json.loads(frame.head(20).to_json(orient="records")), "csv": frame.to_csv(index=False)}


service = AnalyticsService()
app = FastAPI(title="AutoClimate Analytics", version="1.0.0", docs_url=None, redoc_url=None)


@app.exception_handler(RequestValidationError)
async def invalid_request(request: Request, error: RequestValidationError):
    # Exclude raw inputs, including NaN/Infinity that cannot be encoded as JSON.
    issues = [{"loc": issue["loc"], "msg": issue["msg"], "type": issue["type"]} for issue in error.errors()]
    return JSONResponse({"detail": issues}, status_code=422)


@app.middleware("http")
async def no_cache(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/summary")
def summary(days: int | None = Query(default=None, ge=1, le=365)):
    return service.summary(days)


@app.post("/predict")
def predict(body: PredictionInput):
    return {"power_w": float(service.predict([body])[0]), "features": body.features()}


@app.post("/batch")
async def batch(request: Request):
    if request.headers.get("content-type", "").split(";")[0] != "text/csv":
        raise HTTPException(415, "Unggah data dengan tipe text/csv.")
    contents = bytearray()
    async for chunk in request.stream():
        contents.extend(chunk)
        if len(contents) > MAX_CSV_BYTES:
            raise HTTPException(413, "Ukuran CSV maksimal 5 MB.")
    return await run_in_threadpool(service.batch, bytes(contents))


@app.get("/template.csv")
def template():
    fields = list(PredictionInput.model_fields)
    row = {"indoor_temp_c": 28.5, "indoor_humidity": 65, "outdoor_temp_c": 33,
           "outdoor_humidity": 75, "occupancy_count": 3, "target_temp_c": 24,
           "hour_of_day": 14, "motion_detected": 1, "ac_power_state": 1,
           "weather_condition": "Clouds", "fan_speed": "Medium", "temp_delta": 4.5}
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=fields)
    writer.writeheader()
    writer.writerow(row)
    return Response(output.getvalue(), media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="contoh-telemetri.csv"'})
