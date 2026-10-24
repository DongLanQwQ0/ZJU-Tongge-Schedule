# 服务器轮换与 1.0.5 验证

## 固定规则

2027-01-24 00:00（Asia/Shanghai）前旧址优先，故障只触发临时轮换，恢复后重新优先旧址；到期永久使用新址，API 在发送前阻止旧址请求。切换不重放写请求、不跨服务器传递登录令牌。新址尚未部署不改变截止规则。

Android 本地比对进行时暂缓页面重载，保留当前结果；真实旧服务器网络请求仍按截止规则禁用。自定义服务器不参与官方轮换。HTTP 例外只允许新 IP；TLS 校验维持原样。

## 有效验证

- Web `npm test`：375 项通过，覆盖此前固定候选。后续健康探测、截止请求保护与静态入口修复，补跑 `node --test test/migration.test.js test/server.test.js`：57 项通过；最终迁移专项 14 项通过。
- Android `node --test test/runtime.test.cjs`：7 项通过。
- 纯 Java `ServerAddressCheck`、`MigrationPolicyCheck`、`ReleaseVersionCheck` 通过：覆盖主备全部可用组合、恢复、失败不永久切换、截止边界、官方 HTTP 限定与自定义地址。
- `:app:assembleRelease :app:lintRelease :app:assembleReleaseAndroidTest --offline` 通过。Lint 无错误，有 10 项警告（SDK/依赖、WebView、图标等），未扩大修改范围。
- API 36 模拟器安装实际 Release APK，执行 `adb shell am instrument -w com.tongge.app.test/com.tongge.app.MigrationInstrumentation` 通过：HTTPS/HTTP 本地资源、限定主机明文策略、503 重连、本地比对及原生选服期间保留结果。
- Web 实际 Chromium：320px / 22.5px 字体、深浅主题，迁移提示完整，下载与新址链接正确，无横向溢出。测试预览只向迁移函数传入官方主机名，其余 HTML/CSS/JS 使用候选源码。
- Android 实际 WebView：320dp / 150% 字体、深浅主题。截图仅保存压缩副本供审查；窄视口右侧灰区属于测试容器。
- 独立只读审核通过；已修复旧站恢复优先、截止请求窗口、静态 index.html 入口漏口、原生返回历史和本地比对覆盖问题。
- 最终 APK：`com.tongge.app`，versionCode 6 / versionName 1.0.5；沿用 1.0.4 签名。28 个 APK 内置网页资产与源快照直接逐项比较一致；模拟器覆盖安装成功。

临时日志与压缩渲染位于 `F:\Android\temp\tongge-*`；源码检查与渲染证据只适用于本次候选，不代表新服务器已部署。

## 已发布产物

- Web 功能提交 `fd274c7`，Android 功能提交及 v1.0.5 标签对应提交 `b48d76f`，均已推送各自 `main`。
- [Android 1.0.5 正式 Release](https://github.com/DongLanQwQ0/ZJU-Tongge-Schedule-Android/releases/tag/v1.0.5) 已公开，`releases/latest` 返回 v1.0.5。
- `Tongge-1.0.5.apk` 与 `Tongge.apk` 均为 7,074,127 字节，上传状态 `uploaded`，与本地发布安装包长度一致；签名与 1.0.4 相同。两个名字指向同一安装包。

## 上线条件

两个 Git 仓库推送与 APK Release 不替代服务器部署。新服务器需要部署本 Web 后端及数据，并提供健康接口；Web 回旧址的恢复探测依赖本版本 `/api/migration`。旧服务器彻底停机后，首次访问旧 IP 无法运行跳转脚本，需保留独立跳转服务或使用新收藏/APK。
