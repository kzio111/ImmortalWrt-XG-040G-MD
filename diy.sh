#!/bin/bash
# diy.sh —— 编译时自定义脚本
# 执行前当前目录应该是 OpenWrt 源码根目录 ($OPENWRT_PATH)

echo "========================================="
echo " 开始执行 diy.sh —— 拉取主题并启用 devmem"
echo "========================================="

# 1. 拉取 Aurora 主题
if [ ! -d "package/luci-app-aurora" ]; then
    echo "正在拉取 Aurora 主题..."
    git clone --depth=1 https://github.com/xx/aurora-theme.git package/luci-app-aurora
    # 注意：请将上面地址替换为实际的 Aurora 主题仓库地址
    # 例如：git clone --depth=1 https://github.com/sundaqiang/openwrt-packages package/aurora
    echo "✅ Aurora 主题拉取完成"
else
    echo "Aurora 主题已存在，跳过"
fi

# 2. 启用 devmem 支持
#    内核选项：CONFIG_KERNEL_DEVMEM=y
#    Busybox 选项：CONFIG_BUSYBOX_CONFIG_DEVMEM=y
#    确保 .config 中包含这些条目，缺少则追加

add_config_if_missing() {
    local opt="$1"
    if ! grep -q "^${opt}" .config; then
        echo "${opt}" >> .config
        echo "已添加配置: ${opt}"
    else
        echo "配置已存在: ${opt}"
    fi
}

add_config_if_missing "CONFIG_KERNEL_DEVMEM=y"
add_config_if_missing "CONFIG_BUSYBOX_CONFIG_DEVMEM=y"
add_config_if_missing "CONFIG_BUSYBOX_CUSTOM=y"   # devmem 需要自定义 busybox 配置

# 3. 补充说明：如果还需要完整的 Busybox 工具集，可以添加以下行（按需）
# add_config_if_missing "CONFIG_BUSYBOX_DEFAULT=y"

echo "========================================="
echo " diy.sh 执行完毕"
echo "========================================="
