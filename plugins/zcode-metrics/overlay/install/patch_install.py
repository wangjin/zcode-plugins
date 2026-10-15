#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""zcode-metrics · ZCode app.asar 注入/卸载工具（输入框下方 token 用量状态条）。

用法：
  python3 patch_install.py install            # 安装（幂等；复制运行时文件 + 重打包 asar）
  python3 patch_install.py install --finalize # 客户端退出后完成上次留下的 .tmp 替换
  python3 patch_install.py remove             # 卸载（从 asar 剥离注入行，不依赖备份）
  python3 patch_install.py check              # 检查注入状态与入口语法

原理：asar 主入口 out/main/index.js 尾部追加一行 dynamic import(loader)（入口是 ESM，
package.json type:module，实测 2026-10-15）。Electron fuses: EmbeddedAsarIntegrityValidation=0
（参考项目实测），改动 asar 可正常加载。

安装/卸载均只增删本工具自己的注入行（ZCM_LINE_RE 识别，不限目录的历史行一并匹配），
不制作也不依赖 asar 备份：卸载不会连带移除其它工具后装的注入行；ZCode 官方升级覆盖
asar 之后再卸载，也不会把客户端降级回安装时的旧版本。

客户端运行中替换失败（EPERM/EBUSY 等）时留 .tmp 待替换包，完全退出 ZCode 后执行
`install --finalize` 完成收尾。机制移植自 ByteRax/zcode-token-usage-statusbar，注入标记 zcm。
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

IS_MAC = sys.platform == "darwin"
IS_WIN = sys.platform == "win32"

if IS_WIN:
    ASAR_DEFAULT = Path(r"D:\ZCode\resources\app.asar")
elif IS_MAC:
    ASAR_DEFAULT = Path("/Applications/ZCode.app/Contents/Resources/app.asar")
else:
    ASAR_DEFAULT = Path("app.asar")
ASAR = ASAR_DEFAULT
TMP = ASAR.with_name("app.asar.zcm.tmp")
TMP_META = TMP.with_name(TMP.name + ".json")

OVERLAY_SRC = Path(__file__).resolve().parent.parent   # .../overlay/install/patch_install.py → overlay/
RUNTIME = Path.home() / ".zcode" / "zcode-metrics-overlay"
LOADER = RUNTIME / "inject-main.cjs"
RUNTIME_FILES = ["inject-main.cjs", "overlay.js", "query.py", "config.json"]
ENTRY = "out/main/index.js"
# 入口是 ESM（type:module）：dynamic import（CJS/ESM 通用）指向 .cjs loader（在 type:module
# 包里仍按 CJS 加载，require 可用）；asar 内相对路径不可用，用绝对 file URL。
INJECT_LINE_TMPL = '\n;import("{url}").then(() => null, (e) => console.error("[zcm] load failed", e));'
INJECT_LINE = INJECT_LINE_TMPL.format(url=(RUNTIME / "inject-main.cjs").as_uri())
# 匹配任何 zcm 注入行（不限目录）——迁移/重装时剥离旧行用
ZCM_LINE_RE = re.compile(
    rb'\n;import\("[^"]*inject-main\.cjs"\)\.then\(\(\) => null, '
    rb'\(e\) => console\.error\("\[zcm\] load failed", e\)\);'
)
ZCODE_EXE = None
ALIGN = 4
BLOCK = 4194304

CONFIG_DEFAULT = {"context_window": 200000, "activity_min_ms": 1500, "heartbeat_ms": 30000, "resident": True}


def log(msg):
    print(msg)


def set_target(asar_path):
    global ASAR, TMP, TMP_META, ZCODE_EXE
    asar_path = Path(asar_path).resolve()
    ASAR = asar_path
    TMP = asar_path.with_name("app.asar.zcm.tmp")
    TMP_META = TMP.with_name(TMP.name + ".json")
    root = asar_path.parent.parent
    if IS_WIN:
        exe = root / "ZCode.exe"
        ZCODE_EXE = exe if exe.is_file() else None
    elif IS_MAC:
        ZCODE_EXE = root / "MacOS" / "ZCode"
    elif sys.platform.startswith("linux"):
        ZCODE_EXE = root / "zcode"
    else:
        ZCODE_EXE = None


def client_running():
    try:
        if IS_WIN:
            out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq ZCode.exe"],
                                 capture_output=True, text=True, encoding="gbk", errors="replace").stdout
            return "ZCode.exe" in out
        return subprocess.run(["pgrep", "-x", "ZCode"], capture_output=True).returncode == 0
    except Exception:
        return True   # 查不到时按在跑处理，走安全路径


# ---------- asar 读写（pickle header + 流式重打包） ----------

def read_header(f):
    f.seek(0)
    a, b, c, d = struct.unpack("<4I", f.read(16))
    assert a == 4, f"unexpected pickle prefix {a}"
    header = json.loads(f.read(d))
    return header, 8 + b


def iter_files(node, path=""):
    for name, ch in node.get("files", {}).items():
        p = f"{path}/{name}"
        if "files" in ch:
            yield from iter_files(ch, p)
        else:
            yield p, ch


def compute_integrity(data: bytes):
    return {
        "algorithm": "SHA256",
        "hash": hashlib.sha256(data).hexdigest(),
        "blockSize": BLOCK,
        "blocks": [hashlib.sha256(data[i:i + BLOCK]).hexdigest() for i in range(0, len(data), BLOCK)],
    }


def repack(src_path: Path, modify: dict, dst_path: Path):
    """重建 asar。modify: {asar内路径: 新内容bytes}。流式拷贝未改动文件。"""
    with open(src_path, "rb") as src:
        header, base = read_header(src)
        header = json.loads(json.dumps(header))   # 深拷贝
        nodes = dict(iter_files(header))
        missing = set(modify) - set(nodes)
        assert not missing, f"paths not in asar: {missing}"
        data_parts = []
        offset = 0
        for p, node in nodes.items():
            if node.get("unpacked"):
                node["offset"] = "0"
                continue
            if p in modify:
                data = modify[p]
                node["size"] = len(data)
                node["integrity"] = compute_integrity(data)
            else:
                src.seek(base + int(node["offset"]))
                data = src.read(node["size"])
            node["offset"] = str(offset)
            data_parts.append(data)
            offset += len(data)
        payload = b"".join(data_parts)
        header_bytes = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        d = len(header_bytes)
        c = (d + 4 + ALIGN - 1) // ALIGN * ALIGN
        b_total = c + 4
        with open(dst_path, "wb") as out:
            out.write(struct.pack("<4I", 4, b_total, c, d))
            out.write(header_bytes)
            out.write(b"\0" * (c - d - 4))   # pickle 对齐：数据区从 8+b 开始
            assert out.tell() == 8 + b_total, f"header pad mismatch: {out.tell()} vs {8 + b_total}"
            out.write(payload)
    return dst_path


def entry_bytes_of(asar_path: Path) -> bytes:
    with open(asar_path, "rb") as f:
        header, base = read_header(f)
        nodes = dict(iter_files(header))
        node = nodes["/" + ENTRY]
        f.seek(base + int(node["offset"]))
        return f.read(node["size"])


def syntax_check(asar_path: Path) -> bool:
    """用 ZCode 自身当 node（ELECTRON_RUN_AS_NODE）对入口做语法检查；找不到可执行文件跳过。"""
    exe = ZCODE_EXE
    if not exe or not exe.is_file():
        log("  [check] 未找到 ZCode 可执行文件，跳过语法检查")
        return True
    src = entry_bytes_of(asar_path)
    env = dict(os.environ, ELECTRON_RUN_AS_NODE="1")
    fd, name = tempfile.mkstemp(prefix=".zcm-entry-check.", suffix=".js")
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(src)
        r = subprocess.run([str(exe), "--check", name], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", env=env, timeout=60)
    except Exception as e:
        log(f"  [check] 语法检查无法执行（{e}），跳过")
        return True
    finally:
        try:
            os.unlink(name)
        except OSError:
            pass
    log(f"  [check] node --check exit={r.returncode} {r.stderr.strip()[:200]}")
    return r.returncode == 0


def self_check(asar_path: Path, expect: bool) -> bool:
    """结构自检：header 可解析、注入行符合预期。"""
    with open(asar_path, "rb") as f:
        header, base = read_header(f)
        n = sum(1 for _ in iter_files(header))
    entry = entry_bytes_of(asar_path)
    has = INJECT_LINE.encode() in entry if expect else bool(ZCM_LINE_RE.search(entry))
    ok = has == expect
    log(f"  [check] header ok, 文件数={n}, 注入行{'符合' if ok else '不符合'}预期（期望{'有' if expect else '无'}）")
    return ok


# ---------- .tmp 待替换包 ----------

def _file_stamp(path: Path):
    st = Path(path).lstat()
    return {"size": st.st_size, "mtime_ns": st.st_mtime_ns, "dev": st.st_dev, "ino": st.st_ino}


def _load_tmp_meta():
    try:
        meta = json.loads(TMP_META.read_text(encoding="utf-8"))
        if (meta.get("version") == 1 and meta.get("asar") == str(ASAR.resolve())
                and meta.get("operation") in ("install", "remove", "cancelled")):
            return meta
    except (OSError, ValueError):
        pass
    return None


def _atomic_tmp_meta(meta):
    fd, name = tempfile.mkstemp(prefix=TMP_META.name + ".", dir=TMP_META.parent)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(meta, stream)
    os.replace(name, TMP_META)


def _prepare_tmp(modify: dict, operation: str, source: dict):
    fd, name = tempfile.mkstemp(prefix=TMP.name + ".", suffix=".stage", dir=TMP.parent)
    os.close(fd)
    stage = Path(name)
    try:
        repack(ASAR, modify, stage)
        original_stat = ASAR.stat()
        if os.name != "nt":
            stage_stat = stage.stat()
            if (stage_stat.st_uid, stage_stat.st_gid) != (original_stat.st_uid, original_stat.st_gid):
                os.chown(stage, original_stat.st_uid, original_stat.st_gid)
        os.chmod(stage, stat.S_IMODE(original_stat.st_mode))
        meta = {"version": 1, "asar": str(ASAR.resolve()), "tmp_path": str(TMP.absolute()),
                "runtime": str(RUNTIME.resolve()), "operation": operation,
                "source": source, "tmp": _file_stamp(stage)}
        _atomic_tmp_meta(meta)
        os.replace(stage, TMP)
        return meta
    finally:
        stage.unlink(missing_ok=True)


def finalize_tmp(operation: str) -> bool:
    """只收尾可信包且客户端已退出。"""
    if client_running():
        log("客户端仍在运行，先完全退出 ZCode（⌘Q）再收尾。")
        return False
    meta = _load_tmp_meta()
    if not meta or meta["operation"] != operation:
        log("没有待收尾的 .tmp 替换包。")
        return False
    try:
        _file_stamp(ASAR) == meta["source"]
    except OSError as e:
        log(f"来源校验失败：{e}")
        return False
    try:
        if not self_check(TMP, expect=operation == "install"):
            log("待替换包自检失败，保留现场，请重跑 install。")
            return False
        os.replace(TMP, ASAR)
    except OSError as e:
        log(f"替换失败：{e}")
        return False
    try:
        if _load_tmp_meta() == meta:
            TMP_META.unlink()
    except OSError:
        pass
    log("收尾完成。启动 ZCode 生效。")
    return True


# ---------- 运行时目录 ----------

def install_runtime() -> bool:
    """复制 overlay 四件到运行时目录（幂等）。"""
    RUNTIME.mkdir(parents=True, exist_ok=True)
    ok = True
    for name in RUNTIME_FILES:
        src = OVERLAY_SRC / name
        if not src.is_file():
            log(f"[权限] 运行时文件缺失：{src}")
            ok = False
            continue
        dst = RUNTIME / name
        try:
            if name == "config.json" and dst.is_file():
                continue   # 用户配置不覆盖
            shutil.copy2(src, dst)
        except OSError as e:
            log(f"[权限] 复制 {name} 失败：{e}")
            ok = False
    return ok


# ---------- 安装 / 卸载 ----------

def install(finalize=False) -> bool:
    if finalize:
        return finalize_tmp("install")
    if not LOADER.exists() and not install_runtime():
        log("运行时文件准备失败，未修改 asar。")
        return False
    if not os.access(ASAR, os.W_OK) or not os.access(ASAR.parent, os.W_OK):
        log(f"[权限] app.asar 或所在目录不可写：{ASAR}")
        return False
    try:
        source = _file_stamp(ASAR)
        entry = entry_bytes_of(ASAR)
    except (OSError, AssertionError) as e:
        log(f"来源校验失败：{e}")
        return False
    stripped = ZCM_LINE_RE.sub(b"", entry)   # 剥离任何旧注入行（含指向旧目录的）
    if stripped + INJECT_LINE.encode() == entry:
        log("已安装，注入行已指向当前目录。如需重装先 remove。")
        return True
    if stripped != entry:
        log("检测到旧注入行（可能指向旧目录），将替换为新路径。")
    log("重打包（约 340MB，十几秒）...")
    try:
        _prepare_tmp({"/" + ENTRY: stripped + INJECT_LINE.encode()}, "install", source)
    except (OSError, AssertionError) as e:
        log(f"待替换包生成失败，未替换：{e}")
        return False
    if client_running():
        try:
            _replace_pending("install")
            log("\n客户端运行中，但 asar 原子替换成功（运行中进程仍读旧数据）。")
            log("完全重启 ZCode（⌘Q 后重开）后状态条生效。")
            return True
        except OSError as e:
            log(f"\n运行中替换失败（{e}）。完全退出 ZCode 后执行：python3 {Path(__file__)} install --finalize")
            return False
    return _replace_closed()


def _replace_pending(operation):
    """原子替换（紧贴 rename 前再核对一次身份）。"""
    meta = _load_tmp_meta()
    if not meta or meta["operation"] != operation:
        raise OSError("待替换包元数据不符")
    _file_stamp(TMP)
    os.replace(TMP, ASAR)
    try:
        if _load_tmp_meta() == meta:
            TMP_META.unlink()
    except OSError:
        pass
    return True


def _replace_closed():
    try:
        _replace_pending("install")
    except OSError as e:
        log(f"替换失败，保留 .tmp：退出 ZCode 后执行 install --finalize（{e}）")
        return False
    log("完成。启动 ZCode 即可在输入框下方看到状态条。")
    return True


def remove() -> bool:
    try:
        source = _file_stamp(ASAR)
        old = entry_bytes_of(ASAR)
    except (OSError, AssertionError) as e:
        log(f"卸载安全校验失败，未替换：{e}")
        return False
    stripped = ZCM_LINE_RE.sub(b"", old)
    if stripped == old:
        log("当前 asar 未注入。")
        return True
    log("重打包（剥离注入行，约十几秒）...")
    try:
        _prepare_tmp({"/" + ENTRY: stripped}, "remove", source)
        _replace_pending("remove")
    except (OSError, AssertionError) as e:
        log(f"卸载失败（{e}）。请完全退出 ZCode 后重跑 remove。")
        return False
    log("已剥离注入行。重启 ZCode 后生效。")
    return True


def check():
    injected = bool(ZCM_LINE_RE.search(entry_bytes_of(ASAR)))
    print("asar:", ASAR, ASAR.stat().st_size, "bytes")
    print("注入状态:", "已注入" if injected else "未注入")
    print("运行时目录:", RUNTIME, "就绪" if all((RUNTIME / f).is_file() for f in RUNTIME_FILES) else "缺文件（install 会复制）")
    if injected:
        syntax_check(ASAR)
    if TMP.exists():
        print("存在待替换 TMP:", TMP, "（退出 ZCode 后跑 install --finalize）")


def main():
    parser = argparse.ArgumentParser(description="zcode-metrics statusbar asar 注入工具")
    parser.add_argument("command", nargs="?", default="check", choices=["install", "remove", "check"])
    parser.add_argument("--finalize", action="store_true", help="客户端退出后完成 .tmp 替换")
    parser.add_argument("--asar", type=str, default=None, help="app.asar 路径（默认自动定位）")
    args = parser.parse_args()
    if args.asar:
        set_target(Path(args.asar))
    else:
        set_target(ASAR_DEFAULT)
    if args.command == "install":
        ok = install(finalize=args.finalize)
    elif args.command == "remove":
        ok = remove()
    else:
        check()
        ok = True
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
