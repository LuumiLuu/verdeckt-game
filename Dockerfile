# Dockerfile
FROM nginx:alpine

# Deine nginx.conf ins Image kopieren
COPY nginx.conf /etc/nginx/nginx.conf

# Die gebauten statischen Dateien
COPY dist /usr/share/nginx/html
