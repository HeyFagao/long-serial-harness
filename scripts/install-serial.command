#!/bin/sh
# Installs a local package into the existing Harness profile. No app restart.
set -eu

serial_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
serial_profile=${SERIAL_PROFILE:-desktop}
serial_cli=${SERIAL_DSH_COMMAND:-}
serial_archive=${SERIAL_ARCHIVE:-}

if [ -z "$serial_cli" ]; then
  for serial_candidate in \
    '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' \
    "$HOME/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"; do
    if [ -x "$serial_candidate" ]; then serial_cli=$serial_candidate; break; fi
  done
fi
if [ -z "$serial_cli" ]; then serial_cli=$(command -v dsh 2>/dev/null || true); fi
if [ -z "$serial_cli" ] || [ ! -x "$serial_cli" ]; then
  printf '%s\n' '没有找到官方 Harness 的 dsh 命令。' \
    '请先安装官方 DeepSeek Harness，或在应用菜单「管理 dsh 命令」中安装命令。' \
    '应用放在其他位置时，可通过 SERIAL_DSH_COMMAND 指定其 runtime/cli/bin/dsh。' >&2
  exit 1
fi

if [ -z "$serial_archive" ]; then
  serial_count=0
  for serial_candidate in \
    "$serial_dir"/oh-story-dsh-*.tgz \
    "$serial_dir"/../release/oh-story-dsh-*.tgz \
    "$serial_dir"/../packages/dsh-plugin/release/oh-story-dsh-*.tgz; do
    [ -f "$serial_candidate" ] || continue
    serial_archive=$serial_candidate
    serial_count=$((serial_count + 1))
  done
  if [ "$serial_count" -ne 1 ]; then
    printf '%s\n' '需要恰好一个 oh-story-dsh-*.tgz 插件包。' \
      '请把本次交付的插件包放在安装脚本旁；多个包时用 SERIAL_ARCHIVE 指定。' >&2
    exit 1
  fi
fi
if [ ! -f "$serial_archive" ]; then printf '找不到插件包：%s\n' "$serial_archive" >&2; exit 1; fi
serial_archive=$(CDPATH= cd -- "$(dirname -- "$serial_archive")" && printf '%s/%s' "$(pwd -P)" "$(basename -- "$serial_archive")")

printf 'Harness 命令：%s\n安装目标：%s profile\n插件包：%s\n' "$serial_cli" "$serial_profile" "$serial_archive"
"$serial_cli" --version
"$serial_cli" plugin --profile "$serial_profile" add "$serial_archive"
printf '\n%s\n' '安装完成。请在保存当前工作后退出并重新打开 Harness。' \
  '进入作品工作区，新建或打开会话，即可导入大纲和使用长篇连载面板。'
