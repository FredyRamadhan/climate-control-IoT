FROM python:3.13-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1
COPY requirements-api.txt ./
RUN pip install --no-cache-dir -r requirements-api.txt \
    && useradd --uid 10001 --create-home analytics
COPY --chown=analytics:analytics api.py ./
COPY --chown=analytics:analytics data/ ./data/
COPY --chown=analytics:analytics models/ ./models/
USER analytics
EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8001/health', timeout=3)"
CMD ["python", "-m", "uvicorn", "api:app", "--host", "0.0.0.0", "--port", "8001", "--limit-concurrency", "32"]
