# 灵感档案 / Inspiration Backlog

记录 2026-05-06 启动时的方向调研结果，未来技术能力到位时可回头捡起做。

---

## 灵感源
- 博主：**麻省理工 Rui 同学**（小红书）
- 已知作品：「如果地球是一座花园」「鸟语星球（万羽拍音）」「SCI-FI UNIVERSE」
- 课程推荐：[Stanford CS 448B Visualization (Fall 2024)](https://magrawala.github.io/cs448b-fa24/) by Maneesh Agrawala

## 核心 Product Thesis
> "把一个领域的人类知识，凝缩成你想反复打开的、可探索的微型宇宙。"

配方：3D 球/星图 + 真实数据集 + "如果 X 有自己的 Y" 浪漫化命名 + 旋转/点击/筛选三件套 + 深色高密度 sprite

## 已确认硬约束
- 球面只承载粗略量级，精确量交给 2D 旁视图（filter chips、小多重图）
- 连续量用 luminance ramp，类别 ≤6 个 hue
- 3D 必须为真实空间结构服务（地理/宇宙坐标合法）
- 先叙事再开交互（Segel & Heer scrollytelling）
- 技术栈：`react-globe.gl` + 自定义 sprite atlas

---

## 6 个候选方向（按野心 × 可行排序）

### 1. 🌠 陨星档案 / Falling Stars **【已选定，Phase 1 进行中】**
NASA Meteoritical Bulletin（4.5 万条 CC0），按发现年代时间轴坠落入场，按成分（铁/石/球粒）三色分类。
Phase 2 跳出地球：反转视角到小行星带 / 月球 / 火星。

### 2. 🌋 地球脉搏 / Living Earth
USGS 实时地震 + Smithsonian 火山。**实时性=留存机制内置**——每次开都是新数据。
Phase 2 跳出：行星地震学（NASA InSight 火星地震真有数据）。

### 3. 🚢 海底墓园 / Underworld（黑马）
UNESCO 水下文化遗产 + NOAA AWOIS 沉船。**翻转视角**让海面变天花板。
博主圈没人做过，最有可能做出独立形态。

### 4. 🗣️ 巴别塔 / 2.6 万种语言
Glottolog CSV 几 MB，CC-BY。死语言显示为"熄灭的星"，情绪 through-line 自带。
Phase 2 跳出：语言谱系树从地球长出来。

### 5. 🍄 菌丝星球 / Mycelium
GBIF 真菌界 5000 万条下采样。粘菌算法实时生成地下网络。最美但坑最深。

### 6. 🏛️ 文明灯塔 / Ages
UNESCO 1155 + Pleiades 4 万考古点。时间轴从公元前 5000 年播放到现在。

---

## 用户个人想法（待来日打磨）
- **3D 中国美食地图** — 各菜系/小吃的地理分布，可结合食材产地、传播路径
- **电影相关地图** — 取景地、电影背景设定地理、影评热度地图、电影宇宙关系网
  - 灵感方向：把每部电影"拍摄地"+"故事设定地"双轨可视化；按导演/年代/类型筛选；可结合 TMDB API

---

## 不可行 / 不推荐（已踩坑记录）
- 神话生物：无结构化开源数据，靠爬 Wikidata 几百条勉强可行
- 极光历史：NOAA 只有实时预报，无历史观测点结构化数据
- 传统服饰：无开放数据，付费图库
- 咖啡/茶品种血统：数据库无品种原产地坐标
- 流星雨：J14 catalog 可结构化但纬度可见性需自己推算
