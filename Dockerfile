# The Thaliyola website (branch "website"): the root Dockerfile serves site/ with nginx, for hosts that build the
# root Dockerfile. main keeps the demo image at the root. Update with: git merge main (keep this Dockerfile).
FROM nginx:1.27-alpine
COPY site/index.html /usr/share/nginx/html/index.html
COPY apps/web/public/favicon.svg /usr/share/nginx/html/favicon.svg
COPY docs/images/ /usr/share/nginx/html/images/
EXPOSE 80
