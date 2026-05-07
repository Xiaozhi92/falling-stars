# Design Brief — 陨星档案 / Falling Stars

## Aesthetic Direction
**天文台档案室（Astronomical Observatory Archive）**
冷古典 × 现代发光：19 世纪天文台标本陈列 × 现代天体物理可视化

## Color Tokens
```
--ink:        #0B0E18   /* 夜墨主底 */
--paper:      #E8E1CD   /* 旧纸米白 */
--paper-dim:  #A39B85   /* 副文本 */
--amber:      #D4A85F   /* 琥珀刻字 / 高亮 */
--amber-soft: #6B532C   /* 暗琥珀分隔 */

/* 陨石分类（低饱和，非 rainbow） */
--iron:       #7C7670
--stone:      #A8957A
--stony-iron: #9B6F4A

/* 量级量化（luminance ramp，不混 hue） */
--lum-0..4:   #2A2D38 → #E8E1CD
```

## Typography
- Display: GT Sectra / Cormorant Garamond / Source Han Serif（衬线、印刷感）
- Body: IBM Plex Mono（等宽衬线、刻印气质）
- Numerals: tabular-nums，所有编号用 `№ 00000` 格式

## Motion Rules
- 自转：0.3°/s（凝视感，不眩晕）
- 入场坠落：`cubic-bezier(.7,0,.3,1)` + 0.05s 微震（铁石撞地感）
- UI 微动：`0.15s ease-out`，克制
- 详情卡：fade + 1px 上移，无 scale

## 严禁
- 紫色渐变 / Inter / Space Grotesk / 玻璃拟态 / 发光半透明卡 / typing animation / 渐变文字
- hue rainbow 编码量级
- 球做装饰用——必须为真实地理坐标服务

## Layout Skeleton (Phase 1)
```
┌──────────────────────────────────────────────┐
│ FALLING STARS · 陨星档案    1789 → 2013      │
│                                              │
│             ┌─────────────┐                  │
│             │             │  ← 详情卡 (CSS2D)│
│             │   GLOBE     │                  │
│             │             │                  │
│             └─────────────┘                  │
│                                              │
│ ░░░░░░░░░░░░▓░░░░░░░░░░░░  ← 时间轴          │
│ FILTER: ◉ Iron · ○ Stone · ○ Stony-Iron      │
└──────────────────────────────────────────────┘
```
