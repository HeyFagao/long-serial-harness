/** Deterministic test data for native model output; never touches project files or ledgers. */
export interface NativeOutputOptions {
  readonly bookKey: string;
  readonly chapter: number;
  readonly minChars?: number;
}

const ITEMS = [
  "旧木柜", "铜门环", "雨棚", "瓷茶碗", "黄布包", "石阶", "油纸伞", "白瓷盘",
  "算盘", "竹藤椅", "账簿", "红漆盒", "水缸", "青砖", "板车", "铁门栓",
  "木尺", "纸灯笼", "旧船票", "棉线团", "棕绳", "竹篮", "铅笔", "草帽"
] as const;
const PLACES = [
  "南街茶铺", "东门小巷", "河边仓房", "桥头渡口", "粮行后院", "钟楼底下",
  "北街药铺", "旧书摊前", "裁缝铺里", "木器行外", "磨坊门口", "城南驿站"
] as const;
const OBSERVATIONS = [
  "上面还留着昨天的雨痕", "边角被人磨得圆滑", "底部印着陌生的姓氏", "侧面有一道新刻的记号",
  "旧账里的数目与实物相符", "送货的人记错了交付时辰", "掌柜特意留下了一张收条", "门口的孩子认得送货车夫",
  "账房用红笔补上了欠款", "隔壁邻居愿意出面作证", "布袋里的东西比原先少了一件", "柜台背后藏着另一张清单"
] as const;
const ACTIONS = [
  "她把来人的姓名记在纸上，约好午后再到店里核对", "伙计请两位客人坐着等候，随后去后院寻找当日的存根",
  "老人坚持当面清点一遍，连打包用的绳结也逐个查看", "守门人认出了她带来的凭据，立刻让开半边通道",
  "小贩从怀中找出零钱，数清以后又请邻铺掌柜验看", "跑腿的少年交代完来路，便带着签好的回条赶往下一家",
  "店主承认货物曾经换手，同意把经手人的地址补在纸背", "掌柜请她留下拓印，自己另取一本旧册查阅当年的往来"
] as const;
const HOOKS = ["物证揭示", "选择悬念", "身份疑问"] as const;
const visibleChars = (text: string): number => [...text.replace(/\s/gu, "")].length;

/**
 * Return the actual green-workbench wire format: plain prose + named state fields.
 * The legacy marker is deliberately followed by text, not JSON. Each sample
 * carries its book and chapter identity in both parts, allowing isolation checks
 * without accessing private manuscripts or bypassing the real output parser.
 */
export function deterministicNativeOutput({ bookKey, chapter, minChars = 2350 }: NativeOutputOptions): string {
  if (!/^[\p{L}\p{N}_-]{1,80}$/u.test(bookKey)) throw new Error("Fixture bookKey must contain 1–80 letters, digits, underscores or hyphens.");
  if (!Number.isSafeInteger(chapter) || chapter < 1) throw new Error("Fixture chapter must be a positive integer.");
  if (!Number.isSafeInteger(minChars) || minChars < 100 || minChars > 100_000) throw new Error("Fixture minChars must be an integer between 100 and 100000.");
  const paragraphs = [
    `沈宁抵达城南的第${String(chapter)}天，街上的铺面刚刚卸下门板。她带着写有${bookKey}字样的账册，准备把欠账逐户核清。`
  ];
  let index = 0;
  // Complete sentences keep the mechanical fixture valid without truncation or
  // style-check exemptions. The final threshold leaves room for the closing beat.
  while (visibleChars(paragraphs.join("")) < minChars) {
    const item = ITEMS[(index + chapter) % ITEMS.length]!;
    const place = PLACES[(index * 5 + chapter) % PLACES.length]!;
    const observation = OBSERVATIONS[(index * 7 + chapter) % OBSERVATIONS.length]!;
    const action = ACTIONS[(index * 3 + chapter) % ACTIONS.length]!;
    paragraphs.push(`第${String(index + 1)}份收条把她引到${place}。这回要查的是${item}，${observation}。${action}，这一笔往来记在第${String(index + 1)}页。`);
    index += 1;
  }
  paragraphs.push(`${bookKey}第${String(chapter)}本账册合拢时，门外送来一封没有署名的信。信里夹着她一直寻找的那张原始契约。`);
  const body = paragraphs.join("\n\n");
  const title = `第${String(chapter)}章 ${bookKey}的账册`;
  const hook = HOOKS[(chapter - 1) % HOOKS.length]!;
  return `${title}\n\n${body}\n\n【状态变更】\n本章摘要：沈宁核清${bookKey}第${String(chapter)}本账册，收到原始契约。\n实际字数：${String(visibleChars(body))}\n章尾钩类型：${hook}\n人物：\n- 沈宁：完成${bookKey}第${String(chapter)}次核账，现于城南客栈保管契约。\n伏笔：无\n时间：第${String(chapter)}日傍晚\n与章纲不同的地方及原因：无\n下一章必须接住的事：核查${bookKey}契约的来路。\n`;
}
