FROM node:20-slim

# Устанавливаем Python, pip и системные библиотеки
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Создаем виртуальное окружение Python
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Обновляем pip и ставим пакеты для скрипта-чекера и yt-dlp
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir aiohttp aiohttp_socks yt-dlp

# Создаем рабочую директорию проекта
WORKDIR /app

# Копируем package.json (если есть) или сразу ставим npm пакеты
RUN npm install express axios socks-proxy-agent

# Копируем все остальные файлы проекта в контейнер
COPY . .

# Открываем порт для Render.com
EXPOSE 3000

# Запускаем Node.js сервер
CMD ["node", "server.js"]
