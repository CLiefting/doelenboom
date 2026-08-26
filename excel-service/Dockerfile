FROM python:3.12-slim
WORKDIR /app
# JRE nodig voor mpxj (zie requirements.txt / app/mpp_converter.py): mpxj is een
# Java-bibliotheek (hier via JPype aangeroepen) om het binaire MS Project
# .mpp-formaat te lezen — daar bestaat geen bruikbare pure-Python-library voor.
# "headless" (geen GUI-libs) om de image zo klein mogelijk te houden.
RUN apt-get update && apt-get install -y --no-install-recommends default-jre-headless \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
