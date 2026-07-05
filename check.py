import asyncio
import argparse
import sqlite3
import urllib.request
import aiohttp
from aiohttp_socks import ProxyConnector

parser = argparse.ArgumentParser(description="Асинхронный чекер прокси с сохранением в SQLite.")
parser.add_argument("-i", "--input", required=True)
parser.add_argument("-p", "--proto", required=True, choices=["http", "https", "socks5"])
parser.add_argument("-u", "--url", required=True)
parser.add_argument("-o", "--output", default="proxies.db", help="Путь к файлу базы данных SQLite")
parser.add_argument("-t", "--timeout", type=int, default=5)
parser.add_argument("-l", "--limit", type=int, default=500)

args = parser.parse_args()

# Инициализация базы данных
def init_db(db_path):
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS active_proxies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            proxy_string TEXT UNIQUE,
            protocol TEXT
        )
    """)
    conn.commit()
    return conn

async def check_single_proxy(semaphore, session, proxy_str, proto, test_url, timeout):
    proxy_url = f"{proto}://{proxy_str}" if "://" not in proxy_str else proxy_str
    async with semaphore:
        try:
            if proto == "socks5":
                connector = ProxyConnector.from_url(proxy_url)
                async with aiohttp.ClientSession(connector=connector) as proxy_session:
                    async with proxy_session.get(test_url, timeout=timeout) as response:
                        if response.status == 200:
                            return proxy_str
            else:
                async with session.get(test_url, proxy=proxy_url, timeout=timeout) as response:
                    if response.status == 200:
                        return proxy_str
        except Exception:
            pass
        return None

async def main():
    proxies = []
    if args.input.startswith("http://") or args.input.startswith("https://"):
        try:
            with urllib.request.urlopen(args.input, timeout=10) as response:
                content = response.read().decode("utf-8")
                proxies = [line.strip() for line in content.splitlines() if line.strip()]
        except Exception as e:
            print(f"Ошибка загрузки URL: {e}")
            return
    else:
        with open(args.input, "r", encoding="utf-8") as f:
            proxies = [line.strip() for line in f if line.strip()]

    if not proxies:
        return

    semaphore = asyncio.Semaphore(args.limit)
    client_timeout = aiohttp.ClientTimeout(total=args.timeout)
    
    async with aiohttp.ClientSession(timeout=client_timeout) as session:
        tasks = [check_single_proxy(semaphore, session, p, args.proto, args.url, args.timeout) for p in proxies]
        results = await asyncio.gather(*tasks)

    working_proxies = [res for res in results if res is not None]

    # Сохранение в базу данных
    conn = init_db(args.output)
    cursor = conn.cursor()
    
    # Очищаем старые прокси этого же протокола
    cursor.execute("DELETE FROM active_proxies WHERE protocol = ?", (args.proto,))
    
    # Записываем новые живые прокси
    for proxy in working_proxies:
        try:
            cursor.execute("INSERT OR IGNORE INTO active_proxies (proxy_string, protocol) VALUES (?, ?)", (proxy, args.proto))
        except Exception:
            pass
            
    conn.commit()
    conn.close()
    print(f"Успешно. Сохранено живых прокси: {len(working_proxies)}")

if __name__ == "__main__":
    asyncio.run(main())
