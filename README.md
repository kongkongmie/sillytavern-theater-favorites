# 小剧场收藏夹

SillyTavern 第三方扩展，用来收藏、阅读和管理聊天中的小剧场。

这是一个独立插件，不要求安装 KKM Tools。插件由“前端扩展”和“服务插件”两部分组成，两部分都安装后才能把收藏完整保存到本地文件。

## 安装

### 1. 安装前端扩展

通过 SillyTavern 的“安装扩展”填写：

```text
https://github.com/kongkongmie/sillytavern-theater-favorites
```

或者把仓库文件夹放到：

```text
SillyTavern/public/scripts/extensions/third-party/theater-favorites
```

### 2. 安装服务插件

把仓库中的：

```text
server-plugin/theater-favorites
```

复制到：

```text
SillyTavern/plugins/theater-favorites
```

在 `config.yaml` 中确认：

```yaml
enableServerPlugins: true
```

随后重启 SillyTavern 后台，并在浏览器按 `Ctrl + F5`。收藏夹“设置”页面会分别显示“前端已加载”和“后端已连接”。

## 功能

- 默认识别 `<snow>...</snow>`，可添加其他标签。
- 支持识别 `details` 折叠结构。
- 每个小剧场旁显示收藏按钮。
- 管理面板一次只渲染当前展开的小剧场。
- HTML 小剧场在隔离预览中运行。
- 使用完整内容 SHA-256 防止重复收藏。
- 支持搜索、角色/聊天/来源筛选和自定义标签。
- 支持完整 JSON 备份的导入导出，以及浏览器可打开的 HTML 阅读副本。
- 实验性兼容拟界文库，可在识别设置中关闭。

## 本地存储

收藏内容完整保存在 SillyTavern 当前用户目录，不截断正文、HTML 或脚本。

```text
SillyTavern/data/<当前用户>/theater-favorites/
|-- index.json
`-- items/
    |-- tf_xxx_000001.json
    `-- tf_xxx_000002.json
```

`index.json` 只保存标题、日期、SHA-256、大小等轻量目录信息。每个小剧场使用独立 JSON 文件，点开时才读取对应文件，单条删除会直接释放该文件。索引使用临时文件替换并保留备份；索引损坏时可以从 `items` 重建。

超过 20 MB 的单条收藏会在加载预览前提示。设置中的“本地存储”可以查看占用、整理孤立文件或清空全部收藏。

旧版 JSONL 数据会在服务插件启动后自动迁移，成功后才移除旧分片。

完整备份 JSON 用于迁移和恢复。HTML 导出仅用于浏览器阅读，不能代替完整备份。

## 与 KKM Tools 的关系

KKM Tools 只提供可选入口。没有安装 KKM Tools 时，小剧场收藏夹仍会显示自己的工具栏入口并可独立使用；没有安装小剧场收藏夹时，KKM Tools 的其他功能也不受影响。

## 隐私与权限

- 收藏内容只发送到当前 SillyTavern 实例的本地服务插件。
- 服务插件只读写当前用户目录下的 `theater-favorites` 文件夹。
- 插件自身不上传收藏内容。
- HTML 小剧场可能包含作者编写的脚本或外部资源；互动预览与 HTML 导出应视为运行该小剧场代码。

## 许可证

[MIT License](LICENSE)
