# 夹具人格 · base

这是**测试夹具**，不是她的人格文本。

`setup` 那条线要验的是机制：包内的 `persona/*.md` 与三个 preset 能不能装进 `$DSH_HOME`，
以及守卫能不能据此判"她已有人格"。所以这份文本必须填好且不带出厂模板那套 TODO 行
—— 判"有人写过"看的是 TODO（`src/preset/render.ts`），不是文件非空。
