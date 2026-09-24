FROM python:3.12-slim AS base
WORKDIR /app
RUN pip install --no-cache-dir --upgrade pip

COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .

# Never touches docker.sock or any host resource directly - only talks to
# skills-mcp/Ollama/Postgres/Redis/Honcho over the network - so it runs as
# non-root like every other application service in this project.
RUN groupadd --system agent && useradd --system --gid agent agent
USER agent

EXPOSE 3010
ENV PORT=3010
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "3010"]
