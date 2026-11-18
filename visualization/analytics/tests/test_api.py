import io
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import HTTPException
from pydantic import ValidationError

from api import AnalyticsService, PredictionInput, ROOT, service, template


class AnalyticsTests(unittest.TestCase):
    def features(self):
        return {
            "indoor_temp_c": 28.5, "indoor_humidity": 65, "outdoor_temp_c": 33,
            "outdoor_humidity": 75, "occupancy_count": 3, "target_temp_c": 24,
            "hour_of_day": 14, "motion_detected": 1, "ac_power_state": 1,
            "weather_condition": "Clouds", "fan_speed": "Medium",
        }

    def test_existing_model_matches_saved_holdout_predictions(self):
        frame = pd.read_csv(ROOT / "models/test_predictions_sample.csv").head(20)
        rows = [PredictionInput.model_validate({key: row[key] for key in PredictionInput.model_fields if key != "temp_delta"})
                for row in frame.to_dict(orient="records")]
        np.testing.assert_allclose(service.predict(rows), frame.predicted_power_w, atol=0.02)

    def test_summary_reports_actual_dataset_size_and_last_24_hours(self):
        summary = service.summary()
        self.assertEqual(summary["dataset"]["rows"], 10000)
        self.assertEqual(summary["dataset"]["source"], "synthetic")
        self.assertEqual(summary["dataset"]["sample_interval_seconds"], 60)
        self.assertTrue(summary["model_ready"])
        self.assertEqual(len(summary["hourly"]), 24)
        self.assertEqual(service.summary(1)["dataset"]["rows"], 1440)
        json.dumps(summary, allow_nan=False)

    def test_energy_uses_actual_sample_interval_and_all_observations(self):
        with tempfile.TemporaryDirectory(prefix="auto-climate-analytics-") as temporary:
            directory = Path(temporary).resolve()
            self.assertTrue(directory.is_relative_to(Path(tempfile.gettempdir()).resolve()))
            (directory / "data").mkdir()
            pd.DataFrame({
                "timestamp": ["2026-01-01 00:00:00", "2026-01-01 00:02:00", "2026-01-01 00:04:00"],
                "ac_power_consumption_w": [1000, 2000, 0], "ac_power_state": [1, 1, 0],
                "indoor_temp_c": [26, 28, 24], "outdoor_temp_c": [30, 32, 29], "occupancy_count": [1, 4, 0],
            }).to_csv(directory / "data/climate_telemetry_100k.csv", index=False)
            summary = AnalyticsService(directory).summary()
            self.assertAlmostEqual(summary["metrics"]["energy_kwh"], 0.1)
            self.assertAlmostEqual(summary["metrics"]["average_power_w"], 1000)
            self.assertFalse(summary["model_ready"])
            self.assertIsNone(summary["evaluation"])

    def test_derived_delta_is_computed_and_categories_normalized(self):
        body = PredictionInput.model_validate({**self.features(), "temp_delta": 999, "fan_speed": " high "})
        self.assertEqual(body.features()["temp_delta"], 4.5)
        self.assertEqual(body.features()["fan_speed"], "High")

    def test_invalid_and_nonfinite_feature_values_are_rejected(self):
        for patch in [{"target_temp_c": 31}, {"indoor_temp_c": float("nan")}, {"outdoor_humidity": float("inf")},
                      {"occupancy_count": -1}, {"hour_of_day": 24}, {"fan_speed": "turbo"}, {"unexpected": True}]:
            with self.subTest(patch=patch), self.assertRaises(ValidationError):
                PredictionInput.model_validate({**self.features(), **patch})

    def test_batch_derives_delta_preserves_columns_and_predicts_all_rows(self):
        frame = pd.DataFrame([{**self.features(), "note": "=SUM(A1)"}, {**self.features(), "note": "scenario"}])
        result = service.batch(frame.to_csv(index=False).encode())
        exported = pd.read_csv(io.StringIO(result["csv"]))
        self.assertEqual(result["row_count"], 2)
        self.assertEqual(len(exported), 2)
        self.assertTrue((exported.temp_delta == 4.5).all())
        self.assertTrue((exported.predicted_power_w >= 0).all())
        self.assertEqual(exported.note.iloc[0], "'=SUM(A1)")

    def test_csv_validation_reports_missing_fields_duplicate_headers_and_row_errors(self):
        invalid = [b"", b"temp\n24\n", b"x,x\n1,2\n", b"\xff\xfe"]
        bad_row = pd.DataFrame([{**self.features(), "target_temp_c": 100}]).to_csv(index=False).encode()
        for contents in [*invalid, bad_row]:
            with self.subTest(contents=contents[:30]), self.assertRaises(HTTPException) as context:
                service.batch(contents)
            self.assertEqual(context.exception.status_code, 422)

    def test_csv_row_limit_is_enforced_before_prediction(self):
        contents = pd.DataFrame([self.features()] * 10001).to_csv(index=False).encode()
        with self.assertRaises(HTTPException) as context:
            service.batch(contents)
        self.assertEqual(context.exception.status_code, 422)
        self.assertIn("10000", context.exception.detail)

    def test_downloadable_template_is_a_valid_batch_input(self):
        result = service.batch(template().body)
        self.assertEqual(result["row_count"], 1)
        self.assertTrue(result["preview"][0]["predicted_power_w"] >= 0)


if __name__ == "__main__":
    unittest.main()
