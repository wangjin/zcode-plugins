#!/bin/sh
# 重建置顶速度徽章二进制（需要 Xcode Command Line Tools 的 swiftc；产物已随仓库分发，一般无需重建）
# 用法: badge/build.sh   （在插件根目录执行；arm64 macOS）
set -e
cd "$(dirname "$0")/.."
swiftc -O -o bin/tsd-badge badge/badge.swift
echo "built: $(file bin/tsd-badge)"
