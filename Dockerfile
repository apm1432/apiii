FROM node:20-slim

# Python + nginx install
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 python3-pip nginx && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Node.js deps
COPY package*.json ./
RUN npm install --omit=dev

# Python deps (wapi)
COPY wapi/requirements.txt ./wapi/
RUN pip3 install --no-cache-dir -r wapi/requirements.txt --break-system-packages

# सगळे files copy
COPY . .

# nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf
RUN rm -f /etc/nginx/sites-enabled/default

RUN sed -i 's/\r$//' start.sh && chmod +x start.sh

EXPOSE 8000

CMD ["/bin/bash", "start.sh"]
