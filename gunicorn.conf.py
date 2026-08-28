import os

# render assigns the port dynamically. if the start command also passes an
# explicit --bind, that CLI flag wins over this - no conflict either way
bind = f"0.0.0.0:{os.environ.get('PORT', 5001)}"

# every route here just proxies to tfnsw/osm and waits on network i/o - threads
# share memory (unlike separate worker processes), so this adds concurrency
# without multiplying RAM on a constrained instance
workers = 2
threads = 4
worker_class = "gthread"

# default 30s timeout can be exceeded by /api/departures' retry path (up to
# ~40s worst case: two attempts at the 20s upstream timeout) - a worker killed
# mid-request looks like a dropped connection to the client
timeout = 60
