// Synthetic diagnostic sets. Each topic has an obsolete value, an active value,
// a same-object distractor and an unresolved plan. Dev/test topics do not overlap.
import { Store } from '../src/store.js'
import { legacyCandidates } from '../src/memory.js'

const topics = [
  ['画册','装订方式','锁线','胶装','书页是怎么固定在一起的','封面纸张','印厂电话'],
  ['巡检','签到凭证','照片','签名','怎么证明人到过现场','人员名单','车辆号牌'],
  ['录音','采样频率','四十八千赫','四十四千赫','声音每秒采多少次','文件格式','乐手姓名'],
  ['温室','浇水间隔','三天','五天','隔多久给植物补一次水','喷头型号','肥料品牌'],
  ['展览','作品署名','林野','江川','作者那栏应该填谁','展柜高度','票价'],
  ['航拍','返航电量','百分之三十','百分之二十','还剩多少电就要飞回来','拍摄时段','保险单号'],
  ['打样','验色光源','日光灯箱','白炽灯','核对印刷颜色时用哪种灯','纸张规格','交付地址'],
  ['冷库','保鲜温度','四度','八度','东西放进去要多冷','巡查时间','保险公司'],
  ['播客','降噪方式','手工修剪','自动门限','最后怎么去掉环境杂音','片头音乐','嘉宾电话'],
  ['剧场','散场出口','东侧门','南侧门','演完观众从哪边出去','座位排数','餐点价格'],
  ['画展','场景出处','溪岸工作室','原野团队','布景借的是谁家的','海报字体','运输单号'],
  ['装机','备份位置','外接硬盘','本地分区','重装前的副本放哪里','系统语言','主板产地'],
  ['制片','母版帧率','二十五帧','三十帧','最终成片每秒几张画面','片尾排序','配音预算'],
  ['展柜','玻璃厚度','八毫米','六毫米','透明挡板最后做多厚','照明功率','钥匙编号'],
  ['茶会','冲泡时长','九十秒','两分钟','泡多久才出汤','茶杯容量','报名电话'],
  ['乐团','排练地点','西厅','小礼堂','平时大家去哪里合奏','指挥顺序','停车费'],
  ['装箱','封口材料','纸胶带','热熔胶','箱子最后用什么粘住','标签尺寸','快递价格'],
  ['译稿','校对负责人','青禾','白杨','最后一遍是谁检查的','术语版本','签约日期'],
  ['园区','夜间照明','地灯','高杆灯','天黑了靠什么照路','围栏高度','保安电话'],
  ['直播','推流码率','六兆','四兆','发出去的视频每秒传多少数据','画面比例','赞助金额'],
]
for (const [split, subset] of [['dev',topics.slice(0,8)],['test',topics.slice(8)]]) {
  const s=new Store(':memory:'); const nodes=[]
  try {
    for(const [i,[topic,attr,value,old,,other]] of subset.entries()) {
      for(const [suffix,claim] of [['old',`${topic}项目的${attr}确定为${old}。`],['now',`${topic}项目的${attr}确定为${value}。`],['other',`${topic}项目的${other}已另存到交付清单。`],['plan',`${topic}团队计划下周做一次复核，尚未执行。`]]) {
        const id=`${i}-${suffix}`;s.recordNodes('p',{nodes:[{id,claim,kind:'decision'}]});if(suffix==='old')s.supersede(id);nodes.push(s.nodeRow(id))
      }
    }
    for(const [i,[topic,attr,,,paraphrase,,unknown]] of subset.entries()) {
      for(const [kind,query,ok] of [['exact',`${topic}的${attr}现在是什么？`,true],['paraphrase',`${topic}这边，${paraphrase}？`,true],['elliptical',paraphrase+'？',true],['unknown',`${topic}的${unknown}是多少？`,false],['plan-not-done',`${topic}上次复核已经发现了哪些具体问题？`,false]]) {
        console.log(JSON.stringify({split,key:`${split}-${i}-${kind}`,kind,query,gold:ok?[`${i}-now`]:[],nodes,seeds:legacyCandidates(s,'p',query,6).map(n=>n.id)}))
      }
    }
  } finally {s.close()}
}
