// =============================================================================
//  KMTC 실시간 추적 프록시  (Supabase Edge Function · Deno)
// -----------------------------------------------------------------------------
//  브라우저 → (이 함수) → KMTC 내부 API 3종 → 정규화 → 브라우저
//  요청 형식은 실제 KMTC(api.ekmtc.com) F12 cURL에서 그대로 가져옴.
//
//  배포:  supabase functions deploy kmtc-track --no-verify-jwt
//  호출:  GET https://<프로젝트>.supabase.co/functions/v1/kmtc-track?ref=KR04375722
// =============================================================================

const BASE = "https://api.ekmtc.com/trans/trans";

// KMTC가 요구하는 공통 헤더 (cURL에서 추출). service-lang=ENG → 영문 항구명.
// Akamai 봇차단 통과에 sec-ch-ua / sec-fetch 계열이 필요함.
const KMTC_HEADERS: Record<string, string> = {
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9,ko;q=0.8",
  "Content-Type": "application/json",
  "Origin": "https://www.ekmtc.com",
  "Referer": "https://www.ekmtc.com/",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  "sec-ch-ua": '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "selected-profile": "{}",
  "service-ctrcd": "US",
  "service-lang": "ENG",
  "service-path": "#/cargo-tracking",
};

// ── 항구 코드 → 좌표(UN/LOCODE). 운송중 화물의 "남은 항로" 도착항 좌표용 ──────
const PORT: Record<string, [number, number, string]> = {
  KAN: [127.70, 34.94, "광양 Kwangyang,KR"],
  PUS: [129.04, 35.10, "부산 Busan,KR"],
  INC: [126.61, 37.46, "인천 Incheon,KR"],
  NSA: [72.95, 18.95, "나바셰바 Nhava Sheva,IN"],
  SIN: [103.83, 1.26, "싱가포르 Singapore"],
  SHA: [121.47, 31.23, "상하이 Shanghai,CN"],
  NGB: [121.54, 29.87, "닝보 Ningbo,CN"],
  HKG: [114.16, 22.30, "홍콩 Hong Kong"],
  TAO: [120.32, 36.07, "칭다오 Qingdao,CN"],
  LCB: [100.88, 13.08, "램차방 Laem Chabang,TH"],
  JKT: [106.88, -6.10, "자카르타 Jakarta,ID"],
  HPH: [106.68, 20.86, "하이퐁 Haiphong,VN"],
  SGN: [106.70, 10.77, "호치민 Ho Chi Minh,VN"],
  MAA: [80.29, 13.08, "첸나이 Chennai,IN"],
  MUN: [72.84, 18.96, "뭄바이 Mumbai,IN"],
};

// nvgSts(항행상태): 0=항해중, 1=정박지, 5=계류(도착)
function navStatus(code: string | number): { arrived: boolean; label: string } {
  const c = String(code ?? "0");
  if (c === "5") return { arrived: true, label: "도착 · 계류" };
  if (c === "1") return { arrived: false, label: "정박지 대기" };
  return { arrived: false, label: "항해 중" };
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}
function fmtTime(s: string): string {
  if (!s) return "";
  const d = String(s);
  if (d.length < 12) return d;
  return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)} ${d.slice(8,10)}:${d.slice(10,12)}`;
}
function pad14(s: string): string {            // 202605061300 → 20260506130000
  const d = String(s ?? "");
  return d.length === 12 ? d + "00" : d;
}
function cleanVsl(v: string): [string, string] {  // "1)TS KELANG/2602W" → ["TS KELANG","2602W"]
  if (!v) return ["", ""];
  const tail = v.includes(")") ? v.split(")").slice(1).join(")") : v;
  const [name, voy] = tail.split("/");
  return [(name || "").trim(), (voy || "").trim()];
}
function thin(coords: number[][], tol = 0.03): number[][] {
  if (!coords.length) return coords;
  const out = [coords[0]];
  for (const p of coords.slice(1)) {
    const last = out[out.length - 1];
    if (Math.abs(p[0]-last[0]) > tol || Math.abs(p[1]-last[1]) > tol) out.push(p);
  }
  return out;
}
// 번호 종류 자동판별: 컨테이너 / 부킹(KR..) / B/L
function detectKind(ref: string): string {
  if (/^[A-Z]{4}\d{7}$/.test(ref)) return "CN";
  if (/^KR/i.test(ref)) return "BK";
  return "BL";
}

// ── KMTC 3개 엔드포인트 호출 ─────────────────────────────────────────────────
async function fetchTracking(ref: string): Promise<any> {
  const r = await fetch(`${BASE}/cargo-tracking/`, {
    method: "POST", headers: KMTC_HEADERS,
    body: JSON.stringify({ dtKnd: detectKind(ref), blNo: ref }),
  });
  if (!r.ok) throw new Error(`cargo-tracking ${r.status}`);
  return await r.json();
}
async function fetchRoute(head: any): Promise<any> {
  const q = new URLSearchParams({
    vslCd: head.vslCd ?? "", rteCd: "AIS", podRteCd: "AIS",
    voyNo: head.voyNo ?? "", portCd: head.polPortCd ?? "",
    etd: pad14(head.etd), eta: pad14(head.eta), vslCnt: "1",
  });
  const r = await fetch(`${BASE}/rf-dg/cargo-previous-route?${q}`, { headers: KMTC_HEADERS });
  if (!r.ok) throw new Error(`previous-route ${r.status}`);
  return await r.json();
}
async function fetchLocation(head: any, vslName: string): Promise<any> {
  const vslVoyStr = `${vslName}/${head.voyNo ?? ""}:`;
  const q = new URLSearchParams({ vslVoyStr, blNo: head.blNo ?? "" });
  const r = await fetch(`${BASE}/rf-dg/rf-data-vsl-location?${q}`, { headers: KMTC_HEADERS });
  if (!r.ok) throw new Error(`vsl-location ${r.status}`);
  return await r.json();
}

// ── 정규화: KMTC 3개 응답 → 뷰어 형식 ────────────────────────────────────────
// searoute-ts 동적 로딩 (실패해도 직선 폴백 — 함수 전체는 안 죽음)
let _seaRoute: any = null;
async function getSeaRoute(): Promise<any> {
  if (_seaRoute === null) {
    try { const m = await import("npm:searoute-ts@2.0.0"); _seaRoute = m.seaRoute; }
    catch (_) { _seaRoute = false; }
  }
  return _seaRoute || null;
}
// 마지막 위치 → 도착항을 실제 바닷길로. [lat,lng] 배열 반환. 실패 시 직선.
async function remainingByCanal(fromLatLng: number[], destLng: number, destLat: number): Promise<number[][]> {
  const sr = await getSeaRoute();
  if (!sr) return [[destLat, destLng]];
  try {
    const r = sr([fromLatLng[1], fromLatLng[0]], [destLng, destLat], { appendOriginDestination: true });
    const coords = r?.geometry?.coordinates as number[][];
    if (Array.isArray(coords) && coords.length) return coords.map((c) => [c[1], c[0]]);
  } catch (_) { /* 직선 폴백 */ }
  return [[destLat, destLng]];
}

async function normalize(tracking: any, route: any, vsl: any) {
  const list = tracking?.cntrList ?? [];
  if (!list.length) throw new Error("조회 결과 없음 (cntrList 비어있음)");
  const head = list[0];

  const containers = list.map((c: any) => c.cntrNo).filter(Boolean);
  const [vessel, voyage] = cleanVsl(head.vslNm || "");
  const polCd = head.polPortCd, podCd = head.podPortCd;
  const o = PORT[polCd], d = PORT[podCd];
  const originName = o ? o[2] : (head.polPortNm || polCd);
  const destName  = d ? d[2] : (head.podPortNm || podCd);

  // 실제 AIS 항적
  const rawPts: number[][] = (route?.vesselPreiousRoute ?? route?.vesselPreviousRoute ?? [])
    .map((p: any) => [parseFloat(p.lttd), parseFloat(p.lngtd)])
    .filter((p: number[]) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  const track = thin(rawPts);

  // 현재 상태
  const loc = (vsl?.rfVslLocationList ?? [])[0] ?? {};
  const { arrived, label } = navStatus(loc.nvgSts);

  // 경로(legs) + 현재 위치
  let path: number[][], currentVertex: number;
  if (track.length >= 2) {
    if (arrived || !d) {
      path = track; currentVertex = track.length - 1;
    } else {
      // 마지막 AIS점 → 도착항을 실제 바닷길(searoute)로
      const last = track[track.length - 1];
      const remaining = await remainingByCanal(last, d[0], d[1]);
      path = [...track, ...remaining];          // 지나온 실제항적 + 남은 바닷길
      currentVertex = track.length - 1;
    }
  } else {
    const oLL = o ? [o[1], o[0]] : [0, 0];
    const dLL = d ? [d[1], d[0]] : [0, 0];
    path = [oLL, dLL]; currentVertex = arrived ? 1 : 0;
  }

  const originLL = track.length ? track[0] : (o ? [o[1], o[0]] : [0, 0]);
  const destLL = (arrived && track.length) ? track[track.length-1] : (d ? [d[1], d[0]] : [0, 0]);

  const events = [
    { type: "VSL_DEP", place: originName.split(",")[0], time: fmtTime(head.etd),
      tz: "", vessel: `${vessel}/${voyage}`, future: false },
    { type: "VSL_ARR", place: destName.split(",")[0], time: fmtTime(head.eta),
      tz: "", vessel: `${vessel}/${voyage}`, future: !arrived },
  ];

  return {
    carrier: "KMTC", scac: "KMTC",
    mbl: head.blNo, booking: head.bkgNo, queryRef: head.bkgNo || head.blNo,
    containers, eta: fmtTime(head.eta), originName, destName,
    ports: [
      { name: originName, role: "origin", lat: originLL[0], lng: originLL[1] },
      { name: destName, role: "destination", lat: destLL[0], lng: destLL[1] },
    ],
    legs: [{ vessel, voyage, path }],
    currentLegIdx: 0, currentVertex,
    positionTs: `${fmtTime(head.eta)} · ${label} · 실제 AIS`,
    events,
  };
}

// ── 엔트리포인트 ─────────────────────────────────────────────────────────────
// ── 캐시 (메모리). 같은 번호 반복 조회 시 KMTC를 다시 안 부름 ───────────────
//   도착 화물: 6시간 / 운송중: 20분. ?nocache=1 이면 강제 새로고침.
const CACHE = new Map<string, { data: any; exp: number }>();
const TTL_ARRIVED = 6 * 60 * 60 * 1000;   // 6시간
const TTL_TRANSIT = 20 * 60 * 1000;        // 20분

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = new URL(req.url);
    const ref = url.searchParams.get("ref")?.trim();
    if (!ref) return json({ error: "ref(부킹/BL/컨테이너 번호) 파라미터가 필요합니다" }, 400);
    const nocache = url.searchParams.get("nocache") === "1";
    const key = ref.toUpperCase();

    // 1) 캐시 확인 (있고 안 만료됐으면 KMTC 안 부르고 바로 반환)
    if (!nocache) {
      const hit = CACHE.get(key);
      if (hit && hit.exp > Date.now()) {
        return json({ ...hit.data, cached: true });
      }
    }

    // 2) 캐시 없음 → KMTC 호출
    const tracking = await fetchTracking(ref);
    const head = tracking?.cntrList?.[0];
    if (!head) return json({ error: "조회 결과 없음", ref }, 404);

    const [vslName] = cleanVsl(head.vslNm || "");
    let route = {}, vsl = {};
    try { route = await fetchRoute(head); } catch (_) { /* 항적 없으면 직선 폴백 */ }
    try { vsl = await fetchLocation(head, vslName); } catch (_) { /* 위치 없으면 etd/eta 판단 */ }

    const data = await normalize(tracking, route, vsl);

    // 3) 캐시 저장 (도착=6시간, 운송중=20분)
    const arrived = data?.events?.[1]?.future === false;
    CACHE.set(key, { data, exp: Date.now() + (arrived ? TTL_ARRIVED : TTL_TRANSIT) });

    return json(data);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
