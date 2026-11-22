# The Thaliyola website (site/index.html), served by nginx. Build from the repo root:
#   docker build -f site/Dockerfile -t thaliyola-site .
FROM nginx:1.27-alpine
COPY site/index.html /usr/share/nginx/html/index.html
COPY apps/web/public/favicon.svg /usr/share/nginx/html/favicon.svg
COPY docs/images/ /usr/share/nginx/html/images/
EXPOSE 80
