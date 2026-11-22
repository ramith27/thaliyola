# The Thaliyola website (branch "website"): the root Dockerfile serves site/ with nginx, for hosts that build the
# root Dockerfile. main keeps the demo image at the root. Update with: git merge main, then copy site/Dockerfile here.
FROM nginx:1.27-alpine
ENV PORT=3000
RUN rm -f /etc/nginx/conf.d/default.conf
COPY site/default.conf.template /etc/nginx/templates/default.conf.template
COPY site/index.html /usr/share/nginx/html/index.html
COPY apps/web/public/favicon.svg /usr/share/nginx/html/favicon.svg
COPY docs/images/ /usr/share/nginx/html/images/
EXPOSE 3000
