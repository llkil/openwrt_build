# SPDX-License-Identifier: GPL-3.0-only
# Per-client realtime traffic monitor: nft hook-layer counters, LuCI trend page.
include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-flowmon
PKG_VERSION:=1.0.0
PKG_RELEASE:=1

LUCI_TITLE:=Per-client realtime traffic monitor
LUCI_DESCRIPTION:=Accounts forwarded and proxied traffic per LAN client with nft hook counters, keeps 48h history and renders a live trend chart.
LUCI_DEPENDS:=+luci-base +nftables
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
