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

# WebAI-to-API (served only under /api/web/v1) -- own venv so it can never
# change the packages used by wapi/Flask. Pinned commit; needs python 3.11/3.12.
# The two sed lines turn ON gemini-webapi's background __Secure-1PSIDTS rotation (upstream passes
# auto_refresh=False); wapi/webai_cookies.py copies the rotated cookies back into MongoDB.
# If this step fails the image still builds; start.sh then simply skips WebAI.
RUN (apt-get update && \
     apt-get install -y --no-install-recommends git ca-certificates python3-venv && \
     rm -rf /var/lib/apt/lists/* && \
     git clone https://github.com/Amm1rr/WebAI-to-API.git /opt/webai && \
     git -C /opt/webai checkout dd85ae0357720b486cdf193ce37b3134fe65ed38 && \
     rm -rf /opt/webai/.git && \
     sed -i 's/auto_refresh=False/auto_refresh=True, refresh_interval=540/' /opt/webai/src/app/services/providers/gemini/client.py && \
     test "$(grep -c 'auto_refresh=True, refresh_interval=540' /opt/webai/src/app/services/providers/gemini/client.py)" = 2 && \
     python3 -m venv /opt/webai-venv && \
     /opt/webai-venv/bin/pip install --no-cache-dir -r /opt/webai/requirements.txt && \
     cp /opt/webai/config.conf.example /opt/webai/config.conf) \
    || (echo "WARNING: WebAI-to-API install failed - /api/web/v1 will be unavailable" && rm -rf /opt/webai-venv)

# सगळे files copy
COPY . .

# WebAI patches: media download route, artifact URLs through it, raw-reply capture (wapi/patch_webai.py)
RUN if [ -d /opt/webai/src ]; then python3 wapi/patch_webai.py || echo "WARNING: webai patch failed"; fi

# nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf
RUN rm -f /etc/nginx/sites-enabled/default

RUN sed -i 's/\r$//' start.sh && chmod +x start.sh

EXPOSE 8000

CMD ["/bin/bash", "start.sh"]
