# The Thaliyola website (site/index.html), served by nginx on $PORT (default 3000). Build from the repo root:
#   docker build -f site/Dockerfile -t thaliyola-site . && docker run -p 3000:3000 thaliyola-site
FROM nginx:1.27-alpine
ENV PORT=3000
RUN rm -f /etc/nginx/conf.d/default.conf
COPY site/default.conf.template /etc/nginx/templates/default.conf.template
COPY site/index.html /usr/share/nginx/html/index.html
COPY apps/web/public/favicon.svg /usr/share/nginx/html/favicon.svg
COPY docs/images/ /usr/share/nginx/html/images/
EXPOSE 3000
