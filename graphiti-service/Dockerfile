FROM python:3.12-slim AS base
WORKDIR /app
RUN pip install --no-cache-dir --upgrade pip

COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .

# Never touches docker.sock or any host resource directly - only talks to
# FalkorDB/Ollama over the network - so it runs as non-root like every
# other application service in this project.
RUN groupadd --system graphiti && useradd --system --gid graphiti graphiti
USER graphiti

EXPOSE 3012
ENV PORT=3012
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "3012"]
