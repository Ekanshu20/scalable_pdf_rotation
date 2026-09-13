# Build context: repository root (see docker-compose.yml and CI).

# ---- Frontend build: Node exists only in this stage, not the runtime image ----
FROM node:20-slim AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# vite.config.ts writes to ../backend/static/dist
RUN npm run build

# ---- API runtime ----
FROM python:3.11-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN python -m pip install --upgrade pip
COPY backend/requirements/api.txt requirements.txt
RUN pip install -r requirements.txt

COPY backend/app app
COPY backend/static static
COPY --from=frontend /build/backend/static/dist static/dist

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
