# SPDX-License-Identifier: GPL-3.0-only
# CPU 频率卡片：在 LuCI 状态页概览注入各 cpufreq policy 的实时频率。
include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-cpufreqview
PKG_VERSION:=1.0.0
PKG_RELEASE:=1

LUCI_TITLE:=CPU frequency card for the LuCI status page
LUCI_DEPENDS:=+luci-base
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
