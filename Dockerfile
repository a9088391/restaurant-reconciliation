FROM ruby:3.4.12@sha256:5803b69dd8a875a9afc7e3bbc10d0ba683e12aad2640dbbd44295b4890cc8927 AS backend
WORKDIR /app/backend
ENV BUNDLE_FROZEN=true
COPY backend/Gemfile backend/Gemfile.lock ./
RUN bundle install
COPY backend/ ./
COPY samples/ /app/samples/

FROM node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS frontend-dependencies
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

FROM frontend-dependencies AS frontend-build
COPY frontend/ ./
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f AS browser
WORKDIR /app/frontend
COPY --from=frontend-dependencies /app/frontend/ ./
COPY frontend/ ./
COPY samples/ /app/samples/

FROM backend AS app
COPY --from=frontend-build /app/frontend/dist/ /app/backend/public/
