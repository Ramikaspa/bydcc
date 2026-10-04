#!/bin/sh
set -eu

simulator_dir="$PWD/MicroOcppSimulator"
store_dir="$simulator_dir/mo_store"
persistent_store="/var/data/microocpp"

mkdir -p "$persistent_store"

if [ ! -f "$persistent_store/.bydcc-data-cleared" ]; then
    rm -f /var/data/byd-ocpp.sqlite \
        /var/data/byd-ocpp.sqlite-wal \
        /var/data/byd-ocpp.sqlite-shm
    : > "$persistent_store/.bydcc-data-cleared"
fi

if [ ! -L "$store_dir" ]; then
    if [ -d "$store_dir" ]; then
        cp -a "$store_dir/." "$persistent_store/"
        rm -rf "$store_dir"
    fi
    ln -s "$persistent_store" "$store_dir"
fi
cd "$simulator_dir"
exec ./build/mo_simulator
