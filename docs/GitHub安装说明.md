# 从 GitHub 安装插件

仓库：[long-serial-harness](https://github.com/HeyFagao/long-serial-harness)（公开，无需 GitHub 登录）。

1. 安装并打开 [官方 DeepSeek Harness](https://deepseek.com/harness/)。已验证宿主版本为 **0.2.2-rc.3**。
2. 打开「插件 → 添加插件 → 包名或地址」，粘贴下面的插件安装直链并安装：

```text
https://github.com/HeyFagao/long-serial-harness/releases/download/v0.1.26-serial.6/oh-story-dsh-0.1.26-serial.6.tgz
```

3. 保存当前工作后重新打开 Harness。在「设置 → 模型」添加自己的中转站地址、密钥和模型。
4. 添加一个空文件夹工作区作为小说书库，打开长篇工作台，批量导入最终输出 TXT／Markdown。

一个文件建立一本小说、一个独立项目。单本可生成 10／20／50 章或全本；书库先勾选再让所选书各新增 10／20／50 章或写至完本，也可明确选择全部可新增的书。先试写 1 章检查线路与文风。

若直链安装受网络影响，可从 [发布页](https://github.com/HeyFagao/long-serial-harness/releases/tag/v0.1.26-serial.6) 下载 `long-serial-partner-0.1.26-serial.6.zip`，解压后运行包内 Mac／Windows 安装脚本；也可在插件安装器填写本地 `.tgz` 的完整路径。

安装器需要上述 `.tgz` 链接或文件，不要填源码仓库地址或 GitHub 的 Source code ZIP。

已安装旧版本的用户：用上面的 serial.6 直链重新添加/更新同一插件，保留书库、其他插件与模型设置。安装后保存工作并重新打开 Harness；旧版本不会因为仓库更新而自动替换。

删除方式保持不变：勾选后点「删除所选书」立即移除，不再确认移入回收站。后台自动停止选中书的生成并永久清理文件，不会因为暂时清理失败把书重新显示出来。需要留稿时先导出。

本版新增所选书暂停／继续和运行中添加新书，书库改为整页选书操作。新的独立标题调用使用作者提供的提示词，生成五个候选与前三推荐后自动选第一项；升级不会重做已保存的标题或正文。
