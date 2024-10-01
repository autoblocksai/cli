FROM node:20

WORKDIR /app

COPY . .

RUN npm ci

RUN npm run build

WORKDIR /app/e2e/typescript

RUN npm install

RUN ls -la
