#!/usr/bin/env python3
"""
IoT Auto Climate Control Module — Model Training & Evaluation
Trains regression models to predict AC power consumption (Watts) from telemetry.
Generates model artifacts, evaluation metrics, and residual diagnostic data.
"""

import os
import json
import time
import argparse
import logging
from pathlib import Path
from typing import Dict, Any, Tuple

import joblib
import numpy as np
import pandas as pd

from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler, OneHotEncoder
from sklearn.compose import ColumnTransformer
from sklearn.pipeline import Pipeline
from sklearn.linear_model import LinearRegression, Ridge
from sklearn.ensemble import HistGradientBoostingRegressor, RandomForestRegressor
from sklearn.metrics import (
    r2_score,
    mean_squared_error,
    mean_absolute_error,
    mean_absolute_percentage_error,
    explained_variance_score,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [ModelTrainer] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("trainer")

# Feature definitions
NUMERIC_FEATURES = [
    "indoor_temp_c",
    "indoor_humidity",
    "outdoor_temp_c",
    "outdoor_humidity",
    "occupancy_count",
    "target_temp_c",
    "temp_delta",
    "hour_of_day",
    "motion_detected",
    "ac_power_state",
]

CATEGORICAL_FEATURES = [
    "weather_condition",
    "fan_speed",
]

TARGET_COLUMN = "ac_power_consumption_w"


def build_preprocessor() -> ColumnTransformer:
    """Builds scikit-learn column transformer for numeric and categorical telemetry features."""
    numeric_transformer = Pipeline(steps=[("scaler", StandardScaler())])
    categorical_transformer = Pipeline(
        steps=[("onehot", OneHotEncoder(handle_unknown="ignore", sparse_output=False))]
    )

    preprocessor = ColumnTransformer(
        transformers=[
            ("num", numeric_transformer, NUMERIC_FEATURES),
            ("cat", categorical_transformer, CATEGORICAL_FEATURES),
        ]
    )
    return preprocessor


def get_model_candidate(model_name: str, random_state: int = 42):
    """Instantiates regression estimator based on identifier."""
    model_name = model_name.lower()
    if model_name in ["hist_gradient_boosting", "histgb", "gradient_boosting", "hgb"]:
        return HistGradientBoostingRegressor(
            max_iter=150,
            learning_rate=0.08,
            max_depth=12,
            min_samples_leaf=20,
            l2_regularization=0.1,
            random_state=random_state,
        )
    elif model_name in ["random_forest", "rf"]:
        return RandomForestRegressor(
            n_estimators=100,
            max_depth=14,
            min_samples_leaf=5,
            n_jobs=-1,
            random_state=random_state,
        )
    elif model_name in ["ridge"]:
        return Ridge(alpha=1.0)
    elif model_name in ["linear", "linear_regression", "ols"]:
        return LinearRegression()
    else:
        raise ValueError(f"Unsupported model type '{model_name}'. Choose from histgb, random_forest, ridge, linear.")


def evaluate_predictions(y_true: np.ndarray, y_pred: np.ndarray) -> Dict[str, float]:
    """Calculates comprehensive regression performance scorecard."""
    rmse = float(np.sqrt(mean_squared_error(y_true, y_pred)))
    mae = float(mean_absolute_error(y_true, y_pred))
    r2 = float(r2_score(y_true, y_pred))
    evs = float(explained_variance_score(y_true, y_pred))

    # Calculate safe MAPE (avoid division by 0 near standby)
    mask = y_true > 1.0
    if np.any(mask):
        mape = float(mean_absolute_percentage_error(y_true[mask], y_pred[mask]) * 100)
    else:
        mape = 0.0

    residuals = y_true - y_pred
    max_error = float(np.max(np.abs(residuals)))
    std_residual = float(np.std(residuals))

    return {
        "r2_score": round(r2, 4),
        "rmse": round(rmse, 2),
        "mae": round(mae, 2),
        "mape_percent": round(mape, 2),
        "explained_variance": round(evs, 4),
        "max_error": round(max_error, 2),
        "std_residual": round(std_residual, 2),
    }


def train_single_model(
    model_type: str,
    X_train: pd.DataFrame,
    y_train: pd.Series,
    X_test: pd.DataFrame,
    y_test: pd.Series,
    preprocessor: ColumnTransformer,
) -> Tuple[Pipeline, Dict[str, Any], np.ndarray]:
    """Fits an end-to-end Pipeline and evaluates on the test holdout."""
    estimator = get_model_candidate(model_type)
    pipeline = Pipeline(steps=[("preprocessor", preprocessor), ("regressor", estimator)])

    logger.info("Training %s on %d samples...", model_type, len(X_train))
    t0 = time.time()
    pipeline.fit(X_train, y_train)
    fit_duration = time.time() - t0
    logger.info("Training complete in %.2f seconds.", fit_duration)

    y_pred_test = pipeline.predict(X_test)
    metrics = evaluate_predictions(y_test.values, y_pred_test)
    metrics["fit_duration_seconds"] = round(fit_duration, 3)
    metrics["model_name"] = model_type

    logger.info(
        "Evaluation results [%s] — R²: %.4f | RMSE: %.2f W | MAE: %.2f W | MAPE: %.2f%%",
        model_type,
        metrics["r2_score"],
        metrics["rmse"],
        metrics["mae"],
        metrics["mape_percent"],
    )
    return pipeline, metrics, y_pred_test


def compute_feature_importances(pipeline: Pipeline) -> Dict[str, float]:
    """Extracts or estimates feature importance scores from fitted pipeline."""
    preprocessor = pipeline.named_steps["preprocessor"]
    regressor = pipeline.named_steps["regressor"]

    # Retrieve transformed feature names
    cat_encoder = preprocessor.named_transformers_["cat"].named_steps["onehot"]
    cat_feature_names = list(cat_encoder.get_feature_names_out(CATEGORICAL_FEATURES))
    all_feature_names = NUMERIC_FEATURES + cat_feature_names

    importances = {}
    if hasattr(regressor, "feature_importances_"):
        raw_importances = regressor.feature_importances_
        for name, imp in zip(all_feature_names, raw_importances):
            importances[name] = float(imp)
    elif hasattr(regressor, "coef_"):
        raw_coefs = np.abs(regressor.coef_)
        total = np.sum(raw_coefs) if np.sum(raw_coefs) > 0 else 1.0
        normalized = raw_coefs / total
        for name, imp in zip(all_feature_names, normalized):
            importances[name] = float(imp)
    else:
        # Uniform fallback
        for name in all_feature_names:
            importances[name] = 1.0 / len(all_feature_names)

    # Sort descending
    sorted_importances = dict(sorted(importances.items(), key=lambda item: item[1], reverse=True))
    return sorted_importances


def run_training_pipeline(
    data_path: Path,
    model_dir: Path,
    selected_model: str = "hist_gradient_boosting",
    compare_all: bool = False,
    test_size: float = 0.2,
    seed: int = 42,
):
    """Orchestrates loading, training, benchmark comparison, and artifact saving."""
    if not data_path.exists():
        raise FileNotFoundError(
            f"Dataset not found at '{data_path}'. Please run generate_mock_data.py first!"
        )

    logger.info("Loading dataset from %s ...", data_path)
    df = pd.read_csv(data_path)
    logger.info("Loaded %d rows with %d columns.", len(df), len(df.columns))

    # Verify columns
    missing_num = [c for c in NUMERIC_FEATURES if c not in df.columns]
    missing_cat = [c for c in CATEGORICAL_FEATURES if c not in df.columns]
    if missing_num or missing_cat or TARGET_COLUMN not in df.columns:
        raise ValueError(
            f"Missing required columns in dataset: {missing_num + missing_cat} target: {TARGET_COLUMN}"
        )

    X = df[NUMERIC_FEATURES + CATEGORICAL_FEATURES]
    y = df[TARGET_COLUMN]

    logger.info("Splitting dataset into train (80%%) and test (20%%) holdouts...")
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=test_size, random_state=seed
    )

    models_to_run = (
        ["linear", "ridge", "random_forest", "hist_gradient_boosting"]
        if compare_all
        else [selected_model]
    )

    results = {}
    pipelines = {}
    predictions = {}

    preprocessor = build_preprocessor()

    for m in models_to_run:
        pipe, metrics, preds = train_single_model(
            model_type=m,
            X_train=X_train,
            y_train=y_train,
            X_test=X_test,
            y_test=y_test,
            preprocessor=preprocessor,
        )
        results[m] = metrics
        pipelines[m] = pipe
        predictions[m] = preds

    # Pick champion model (highest R2 score)
    best_model_name = max(results.keys(), key=lambda k: results[k]["r2_score"])
    best_pipeline = pipelines[best_model_name]
    best_metrics = results[best_model_name]
    best_preds = predictions[best_model_name]

    logger.info("Champion model selected: %s (R² = %.4f)", best_model_name, best_metrics["r2_score"])

    # Feature importances
    feature_importances = compute_feature_importances(best_pipeline)

    # Persist artifacts
    model_dir.mkdir(parents=True, exist_ok=True)
    model_save_path = model_dir / "ac_power_regressor.joblib"
    metrics_save_path = model_dir / "model_metrics.json"
    predictions_sample_path = model_dir / "test_predictions_sample.csv"

    logger.info("Saving trained model artifact to %s ...", model_save_path)
    joblib.dump(best_pipeline, model_save_path)

    metadata = {
        "timestamp": datetime_str(),
        "champion_model": best_model_name,
        "champion_metrics": best_metrics,
        "all_model_benchmarks": results,
        "feature_importances": feature_importances,
        "numeric_features": NUMERIC_FEATURES,
        "categorical_features": CATEGORICAL_FEATURES,
        "target_column": TARGET_COLUMN,
        "training_samples": len(X_train),
        "test_samples": len(X_test),
    }

    logger.info("Saving metadata and benchmark metrics to %s ...", metrics_save_path)
    with open(metrics_save_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)

    # Save a representative test holdout sample (e.g. 5,000 rows) for fast dashboard visualization
    sample_indices = np.random.default_rng(seed).choice(len(X_test), size=min(5000, len(X_test)), replace=False)
    test_sample_df = X_test.iloc[sample_indices].copy()
    test_sample_df["actual_power_w"] = y_test.iloc[sample_indices].values
    test_sample_df["predicted_power_w"] = np.round(best_preds[sample_indices], 2)
    test_sample_df["residual_w"] = np.round(
        test_sample_df["actual_power_w"] - test_sample_df["predicted_power_w"], 2
    )
    test_sample_df.to_csv(predictions_sample_path, index=False)
    logger.info("Saved sample test predictions to %s", predictions_sample_path)

    logger.info("Model training pipeline finished successfully!")


def datetime_str() -> str:
    from datetime import datetime
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train regression models on IoT climate telemetry mock data."
    )
    parser.add_argument(
        "--data-path",
        type=str,
        default=None,
        help="Path to training CSV file (default: tubes/analytics/data/climate_telemetry_100k.csv).",
    )
    parser.add_argument(
        "--model-dir",
        type=str,
        default=None,
        help="Directory to persist model artifacts (default: tubes/analytics/models/).",
    )
    parser.add_argument(
        "--model-type",
        type=str,
        default="hist_gradient_boosting",
        choices=["hist_gradient_boosting", "random_forest", "ridge", "linear"],
        help="Regression model algorithm to train (default: hist_gradient_boosting).",
    )
    parser.add_argument(
        "--compare-all",
        action="store_true",
        help="Train and benchmark all models (Linear, Ridge, RandomForest, HistGB) and pick the champion.",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for data split and estimators (default: 42).",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    script_dir = Path(__file__).resolve().parent

    data_path = (
        Path(args.data_path).resolve()
        if args.data_path
        else script_dir / "data" / "climate_telemetry_100k.csv"
    )

    model_dir = (
        Path(args.model_dir).resolve()
        if args.model_dir
        else script_dir / "models"
    )

    run_training_pipeline(
        data_path=data_path,
        model_dir=model_dir,
        selected_model=args.model_type,
        compare_all=args.compare_all,
        seed=args.seed,
    )


if __name__ == "__main__":
    main()
