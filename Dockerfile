FROM node:20

WORKDIR /app

COPY . .

RUN npm ci

RUN npm run build

RUN ls -la

WORKDIR /app/e2e/typescript

RUN npm install

RUN ls -la

RUN printenv

# RUN ../../bin/cli.js testing setup-ci-context
