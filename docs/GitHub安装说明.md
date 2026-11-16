# 从 GitHub 安装插件

仓库：[long-serial-harness](https://github.com/HeyFagao/long-serial-harness)（公开，无需 GitHub 登录）。

1. 安装并打开 [官方 DeepSeek Harness](https://deepseek.com/harness/)。已验证宿主版本为 **0.2.2-rc.3**。
2. 打开「插件 → 添加插件 → 包名或地址」，粘贴下面的插件安装直链并安装：

```text
https://github.com/HeyFagao/long-serial-harness/releases/download/v0.1.26-serial.3/oh-story-dsh-0.1.26-serial.3.tgz
```

3. 保存当前工作后重新打开 Harness。在「设置 → 模型」添加自己的中转站地址、密钥和模型。
4. 添加一个空文件夹工作区作为小说书库，打开长篇工作台，批量导入最终输出 TXT／Markdown。

一个文件建立一本小说、一个独立项目。单本可生成 10／20／50 章或全本；书库可让所有项目各新增 10／20 章或写至完本。先试写 1 章检查线路与文风。

若直链安装受网络影响，可从 [发布页](https://github.com/HeyFagao/long-serial-harness/releases/tag/v0.1.26-serial.3) 下载 `long-serial-partner-0.1.26-serial.3.zip`，解压后运行包内 Mac／Windows 安装脚本；也可在插件安装器填写本地 `.tgz` 的完整路径。

安装器需要上述 `.tgz` 链接或文件，不要填源码仓库地址或 GitHub 的 Source code ZIP。
