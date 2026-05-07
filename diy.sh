#!/bin/bash
# diy.sh —— OpenWrt 编译前的自定义脚本
# 执行环境：OpenWrt 源码根目录，.config 已由配置文件生成但尚未最终编译

echo "========================================="
echo " 开始执行 diy.sh —— 主题、devmem、中文支持"
echo "========================================="

# ---------- 1. 拉取 Aurora 主题 ----------
AURORA_REPO="https://github.com/eamonxg/luci-theme-aurora.git"
THEME_DIR="package/luci-theme-aurora"

if [ ! -d "$THEME_DIR" ]; then
    echo "正在拉取 Aurora 主题..."
    git clone --depth=1 $AURORA_REPO $THEME_DIR
    echo "✅ Aurora 主题已拉取"
else
    echo "Aurora 主题目录已存在，跳过"
fi

# ---------- 2. 添加缺失的 .config 配置项 ----------
add_config_if_missing() {
    local opt="$1"
    if ! grep -q "^${opt}" .config; then
        echo "${opt}" >> .config
        echo "已添加配置: ${opt}"
    else
        echo "配置已存在: ${opt}"
    fi
}

echo "正在检查并添加 devmem 相关配置..."
add_config_if_missing "CONFIG_KERNEL_DEVMEM=y"
add_config_if_missing "CONFIG_BUSYBOX_CUSTOM=y"
add_config_if_missing "CONFIG_BUSYBOX_CONFIG_DEVMEM=y"

echo "正在检查并添加中文语言支持..."
# 中文语言包（基础界面和防火墙）
add_config_if_missing "CONFIG_PACKAGE_luci-i18n-base-zh-cn=y"
add_config_if_missing "CONFIG_PACKAGE_luci-i18n-firewall-zh-cn=y"
# 强制默认语言为中文（如果编译时未设置）
add_config_if_missing "CONFIG_LUCI_LANG_zh_Hans=y"

# ---------- 3. 补充说明 ----------
# 如果还想安装 Aurora 配套的配置插件，可取消下面三行的注释：
echo "正在拉取 Aurora 配置插件..."
git clone --depth=1 https://github.com/eamonxg/luci-app-aurora-config.git package/luci-app-aurora-config
echo "========================================="
echo " diy.sh 执行完毕"
echo "========================================="
