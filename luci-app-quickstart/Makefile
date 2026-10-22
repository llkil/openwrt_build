#
# Quick Start overview for ImmortalWrt built by openwrt_build
#
# Read-only dashboard: board / network / wireless / services.
# No write ACL on purpose - every action links to the canonical LuCI page.

include $(TOPDIR)/rules.mk

LUCI_TITLE:=Quick Start overview
LUCI_DEPENDS:=+rpcd-mod-iwinfo
LUCI_PKGARCH:=all

PKG_VERSION:=1
PKG_RELEASE:=1
PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=llkil

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
