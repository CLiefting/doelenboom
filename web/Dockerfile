FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 5173
# Alleen lokale ontwikkeling (bind-mounts, dev-server). Productie gebruikt Dockerfile.prod,
# dat niet als root draait (DOEL-31).
# nosemgrep: dockerfile.security.missing-user.missing-user
CMD ["npm", "run", "dev"]
