#!/bin/sh
# Runs as root through pkexec (one password prompt for every board).
# Usage: rfcomm-bind.sh N ADDRESS [N ADDRESS ...] -> rfcomm bind N ADDRESS 1
# Only creates /dev/rfcommN; it never changes file permissions (udev applies root:dialout 660).
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin

if [ "$#" -eq 0 ] || [ $(($# % 2)) -ne 0 ]; then
  echo "usage: $0 N ADDRESS [N ADDRESS ...]" >&2
  exit 2
fi

while [ "$#" -gt 0 ]; do
  device=$1
  address=$2
  shift 2
  case $device in
    '' | *[!0-9]*) echo "invalid device number: $device" >&2; exit 2 ;;
  esac
  if [ "$device" -gt 255 ]; then
    echo "invalid device number: $device" >&2
    exit 2
  fi
  if ! printf '%s\n' "$address" | grep -Eq '^([0-9A-F]{2}:){5}[0-9A-F]{2}$'; then
    echo "invalid address: $address" >&2
    exit 2
  fi
  rfcomm bind "$device" "$address" 1
done
