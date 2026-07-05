# Шаг 1: Используем официальный легковесный образ Node.js
FROM node:20-slim

# Шаг 2: Устанавливаем системные зависимости для Python и компиляции psycopg2
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    libpq-dev \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Шаг 3: Настраиваем виртуальное окружение Python
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Шаг 4: Обновляем pip и устанавливаем пакеты для чекера, PostgreSQL и yt-dlp
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir aiohttp aiohttp_socks yt-dlp psycopg2-binary

# Шаг 5: Создаем и переходим в рабочую директорию приложения
WORKDIR /app

# Шаг 6: Устанавливаем Node.js пакеты (Express, Axios, PostgreSQL, Прокси-агент)
RUN npm install express axios socks-proxy-agent pg undici

# Шаг 7: Копируем все файлы проекта (server.js, check.py, index.html) внутрь контейнера
COPY . .

# Шаг 8: Указываем порт для Render.com
EXPOSE 3000

# Шаг 9: Команда для запуска нашего Node.js сервера
CMD ["node", "server.js"]
