# 长篇连载工作台 · DeepSeek Harness 插件

把已经完成的「最终输出／超级大纲」逐章写成小说。以原绿色版工作台和原版生成、修订提示词为基础，运行在官方 DeepSeek Harness 内。

- 批量导入多份最终输出；每份建立一本书、一个独立原生工作区。
- 单本一键续写 10／20／50 章或全本。
- 书库一键让所有项目各新增 10／20 章，或全部写至完本。
- 每章带入本书完整文风、前 10 章正文全文，使用新的原生会话。
- 逐章保存、暂停／停止／恢复，切换中转站和模型沿用 Harness 原生设置。

![书库按钮与十本示例小说](docs/书库界面示例.png)

## 安装

1. 安装 [官方 DeepSeek Harness](https://deepseek.com/harness/)。当前验证版本为 **0.2.2-rc.3**。
2. 在 Harness「插件 → 添加插件 → 包名或地址」粘贴下面的公开插件安装直链：

```text
https://github.com/HeyFagao/long-serial-harness/releases/download/v0.1.26-serial.3/oh-story-dsh-0.1.26-serial.3.tgz
```

3. 安装后保存当前工作并重新打开 Harness。在「设置 → 模型」添加自己的中转站，选定写作模型。
4. 添加一个空文件夹工作区作为书库，打开长篇工作台并批量选择最终输出文件，然后开始生成。

仓库和发布附件均已公开，无需 GitHub 登录。网络无法直接安装时，从 [v0.1.26-serial.3 发布页](https://github.com/HeyFagao/long-serial-harness/releases/tag/v0.1.26-serial.3) 下载 `long-serial-partner-0.1.26-serial.3.zip` 并解压，按包内说明运行安装脚本或使用本地 `.tgz` 完整路径。不要把源码仓库根目录当作插件安装包。

## 使用与验证

[使用说明](docs/使用说明.md) · [中转站设置](docs/中转站设置.md) · [验收记录](docs/验收记录.md) · [来源说明](docs/来源说明.md)

最终包已用本地模拟模型完成 10 本书、152 章原生流程与四类中转协议测试。**真实付费长批次及文学质量尚未验收。** 电脑与 Harness 需持续运行；退出后重新打开原项目并恢复。

不包含 API 密钥、用户小说原稿或本机配置。原系统提示词及状态约定保留在插件内；无剧本、游戏、视频工作台。源码开发方式见 [源码说明](README-SOURCE.md)。

基于 [zenstory-ai/oh-story-dsh](https://github.com/zenstory-ai/oh-story-dsh) 0.1.26 的原生插件与文件工作台基础（MIT），为专用派生版本，非上游官方发行。
