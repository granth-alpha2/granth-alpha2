import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

interface ContributionDay {
  date: string;
  contributionCount: number;
  contributionLevel: 'NONE' | 'FIRST_QUARTILE' | 'SECOND_QUARTILE' | 'THIRD_QUARTILE' | 'FOURTH_QUARTILE' | string;
  weekday: number; // 0 = Sunday, 6 = Saturday
  color?: string;
}

interface ContributionWeek {
  contributionDays: ContributionDay[];
}

interface ContributionCalendar {
  totalContributions: number;
  weeks: ContributionWeek[];
}

interface UserContributionData {
  login: string;
  name: string;
  calendar: ContributionCalendar;
}

// ---------------------------------------------------------------------------
// 1. Data Fetching (GraphQL with Public & Curl Fallback)
// ---------------------------------------------------------------------------

function fetchWithCurl(url: string, headers: Record<string, string> = {}, postData?: string): string | null {
  try {
    const headerArgs = Object.entries(headers)
      .map(([k, v]) => `-H "${k}: ${v}"`)
      .join(' ');
    const postArg = postData ? `-d '${postData.replace(/'/g, "'\\''")}'` : '';
    const cmd = `curl -s --max-time 15 ${headerArgs} ${postArg} "${url}"`;
    const output = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
    return output;
  } catch {
    return null;
  }
}

async function fetchFromGraphQL(username: string, token: string): Promise<UserContributionData | null> {
  const query = `
    query($login: String!) {
      user(login: $login) {
        name
        contributionsCollection {
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                color
                contributionCount
                contributionLevel
                date
                weekday
              }
            }
          }
        }
      }
    }
  `;

  const bodyStr = JSON.stringify({ query, variables: { login: username } });

  // 1. Try native fetch with timeout
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'dragon-roam-generator',
      },
      body: bodyStr,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const data = (await response.json()) as any;
      if (data.data?.user?.contributionsCollection?.contributionCalendar) {
        const calendar = data.data.user.contributionsCollection.contributionCalendar;
        return {
          login: username,
          name: data.data.user.name || username,
          calendar: {
            totalContributions: calendar.totalContributions,
            weeks: calendar.weeks,
          },
        };
      }
    }
  } catch {
    // Fall through to curl attempt
  }

  // 2. Try curl fallback
  try {
    const curlRes = fetchWithCurl(
      'https://api.github.com/graphql',
      {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'dragon-roam-generator',
      },
      bodyStr
    );
    if (curlRes) {
      const data = JSON.parse(curlRes) as any;
      if (data.data?.user?.contributionsCollection?.contributionCalendar) {
        const calendar = data.data.user.contributionsCollection.contributionCalendar;
        return {
          login: username,
          name: data.data.user.name || username,
          calendar: {
            totalContributions: calendar.totalContributions,
            weeks: calendar.weeks,
          },
        };
      }
    }
  } catch {
    // Fall through
  }

  return null;
}

function parseContributionsHtml(html: string, username: string): UserContributionData | null {
  const tooltipRegex = /<tool-tip[^>]+for="([^"]+)"[^>]*>([^<]+)<\/tool-tip>/gi;
  const tooltips = new Map<string, number>();
  let ttMatch: RegExpExecArray | null;
  while ((ttMatch = tooltipRegex.exec(html)) !== null) {
    const elId = ttMatch[1];
    const text = ttMatch[2];
    const countMatch = /(\d+)\s+contribution/i.exec(text);
    tooltips.set(elId, countMatch ? parseInt(countMatch[1], 10) : 0);
  }

  const days: ContributionDay[] = [];
  const allTdRegex = /<td[^>]+id="([^"]+)"[^>]+data-date="([^"]+)"[^>]+data-level="([^"]+)"[^>]*>/gi;
  let tdMatch: RegExpExecArray | null;

  while ((tdMatch = allTdRegex.exec(html)) !== null) {
    const id = tdMatch[1];
    const dateStr = tdMatch[2];
    const levelNum = parseInt(tdMatch[3], 10) || 0;
    const count = tooltips.get(id) || (levelNum > 0 ? levelNum * 2 : 0);

    const d = new Date(dateStr);
    const weekday = d.getUTCDay();

    const levelMap: Record<number, ContributionDay['contributionLevel']> = {
      0: 'NONE',
      1: 'FIRST_QUARTILE',
      2: 'SECOND_QUARTILE',
      3: 'THIRD_QUARTILE',
      4: 'FOURTH_QUARTILE',
    };

    days.push({
      date: dateStr,
      contributionCount: count,
      contributionLevel: levelMap[levelNum] || 'NONE',
      weekday,
    });
  }

  if (days.length === 0) {
    return null;
  }

  days.sort((a, b) => a.date.localeCompare(b.date));

  const weeks: ContributionWeek[] = [];
  let currentWeek: ContributionDay[] = [];

  for (const day of days) {
    if (day.weekday === 0 && currentWeek.length > 0) {
      weeks.push({ contributionDays: currentWeek });
      currentWeek = [];
    }
    currentWeek.push(day);
  }
  if (currentWeek.length > 0) {
    weeks.push({ contributionDays: currentWeek });
  }

  const totalContributions = days.reduce((sum, d) => sum + d.contributionCount, 0);

  return {
    login: username,
    name: username,
    calendar: {
      totalContributions,
      weeks,
    },
  };
}

async function fetchFromPublicContributions(username: string): Promise<UserContributionData | null> {
  const url = `https://github.com/users/${username}/contributions`;

  // 1. Try native fetch
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const html = await response.text();
      const result = parseContributionsHtml(html, username);
      if (result) return result;
    }
  } catch {
    // Fall through to curl
  }

  // 2. Try curl
  try {
    const html = fetchWithCurl(url, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    });
    if (html) {
      const result = parseContributionsHtml(html, username);
      if (result) return result;
    }
  } catch {
    // Fall through
  }

  return null;
}

function generateFallbackCalendar(username: string): UserContributionData {
  const weeks: ContributionWeek[] = [];
  const now = new Date();
  const daysTotal = 53 * 7;
  const startDate = new Date(now.getTime() - (daysTotal - 1) * 24 * 60 * 60 * 1000);

  let totalContributions = 0;
  let currentWeek: ContributionDay[] = [];

  for (let i = 0; i < daysTotal; i++) {
    const d = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000);
    const weekday = d.getUTCDay();
    const dateStr = d.toISOString().split('T')[0];

    // Seeded pseudo-random activity
    const pseudo = (Math.sin(i * 997 + 13) + 1) / 2;
    let count = 0;
    let level: ContributionDay['contributionLevel'] = 'NONE';

    if (pseudo > 0.65) {
      count = Math.floor((pseudo - 0.65) * 25) + 1;
      totalContributions += count;
      if (count > 10) level = 'FOURTH_QUARTILE';
      else if (count > 5) level = 'THIRD_QUARTILE';
      else if (count > 2) level = 'SECOND_QUARTILE';
      else level = 'FIRST_QUARTILE';
    }

    if (weekday === 0 && currentWeek.length > 0) {
      weeks.push({ contributionDays: currentWeek });
      currentWeek = [];
    }
    currentWeek.push({
      date: dateStr,
      contributionCount: count,
      contributionLevel: level,
      weekday,
    });
  }

  if (currentWeek.length > 0) {
    weeks.push({ contributionDays: currentWeek });
  }

  return {
    login: username,
    name: username,
    calendar: {
      totalContributions,
      weeks,
    },
  };
}

async function getContributionData(username: string): Promise<UserContributionData> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

  if (token) {
    console.log(`Attempting GraphQL API query for user "${username}"...`);
    const gqlData = await fetchFromGraphQL(username, token);
    if (gqlData && gqlData.calendar.weeks.length > 0) {
      console.log(`Successfully fetched ${gqlData.calendar.totalContributions} contributions via GraphQL.`);
      return gqlData;
    }
  }

  console.log(`Fetching public contribution calendar for user "${username}"...`);
  const publicData = await fetchFromPublicContributions(username);
  if (publicData && publicData.calendar.weeks.length > 0) {
    console.log(`Successfully parsed ${publicData.calendar.totalContributions} contributions from public endpoint.`);
    return publicData;
  }

  console.warn('Falling back to local generated contribution baseline.');
  return generateFallbackCalendar(username);
}

// ---------------------------------------------------------------------------
// 2. Flight Path Generator across Contribution Grid
// ---------------------------------------------------------------------------

function buildDragonPath(
  weeks: ContributionWeek[],
  gridStartX: number,
  gridStartY: number,
  cellStep: number
): string {
  const totalCols = weeks.length;
  const gridWidth = totalCols * cellStep;
  const gridHeight = 7 * cellStep;

  // Collect cell center points for active & waypoint days
  const points: { x: number; y: number; level: number }[] = [];

  weeks.forEach((w, colIdx) => {
    w.contributionDays.forEach((d) => {
      const rowIdx = d.weekday;
      const x = gridStartX + colIdx * cellStep + cellStep / 2;
      const y = gridStartY + rowIdx * cellStep + cellStep / 2;

      let levelNum = 0;
      if (d.contributionLevel === 'FIRST_QUARTILE') levelNum = 1;
      if (d.contributionLevel === 'SECOND_QUARTILE') levelNum = 2;
      if (d.contributionLevel === 'THIRD_QUARTILE') levelNum = 3;
      if (d.contributionLevel === 'FOURTH_QUARTILE') levelNum = 4;

      points.push({ x, y, level: levelNum });
    });
  });

  // Build key navigation waypoints across the grid
  const waypoints: { x: number; y: number }[] = [];

  // Entry glide from left
  waypoints.push({ x: gridStartX - 60, y: gridStartY + gridHeight * 0.3 });
  waypoints.push({ x: gridStartX - 20, y: gridStartY + gridHeight * 0.15 });

  // Waypoints across columns
  const stepCols = 4;
  for (let c = 0; c < totalCols; c += stepCols) {
    const colX = gridStartX + c * cellStep + cellStep / 2;
    const colSlice = points.filter(p => Math.abs(p.x - colX) < cellStep * 2);
    const highCell = colSlice.sort((a, b) => b.level - a.level)[0];

    if (highCell && highCell.level > 0) {
      waypoints.push({ x: highCell.x, y: highCell.y });
    } else {
      const wavePhase = Math.sin((c / totalCols) * Math.PI * 3.5);
      const targetY = gridStartY + (gridHeight * 0.5) + wavePhase * (gridHeight * 0.38);
      waypoints.push({ x: colX, y: targetY });
    }
  }

  // Smooth turnaround loop on the right and bottom
  waypoints.push({ x: gridStartX + gridWidth + 35, y: gridStartY + gridHeight * 0.25 });
  waypoints.push({ x: gridStartX + gridWidth + 50, y: gridStartY + gridHeight * 0.75 });
  waypoints.push({ x: gridStartX + gridWidth * 0.75, y: gridStartY + gridHeight + 22 });
  waypoints.push({ x: gridStartX + gridWidth * 0.45, y: gridStartY + gridHeight + 14 });
  waypoints.push({ x: gridStartX + gridWidth * 0.15, y: gridStartY + gridHeight + 18 });
  waypoints.push({ x: gridStartX - 35, y: gridStartY + gridHeight * 0.8 });
  waypoints.push({ x: gridStartX - 60, y: gridStartY + gridHeight * 0.3 });

  if (waypoints.length < 2) {
    return `M ${gridStartX - 50},${gridStartY + 40} L ${gridStartX + gridWidth + 50},${gridStartY + 40}`;
  }

  // Convert waypoints to Catmull-Rom smooth Cubic Bezier Path
  const tension = 0.35;
  let pathD = `M ${waypoints[0].x.toFixed(1)},${waypoints[0].y.toFixed(1)}`;

  for (let i = 0; i < waypoints.length - 1; i++) {
    const p0 = i > 0 ? waypoints[i - 1] : waypoints[i];
    const p1 = waypoints[i];
    const p2 = waypoints[i + 1];
    const p3 = i < waypoints.length - 2 ? waypoints[i + 2] : p2;

    const cp1x = p1.x + ((p2.x - p0.x) * tension) / 2;
    const cp1y = p1.y + ((p2.y - p0.y) * tension) / 2;
    const cp2x = p2.x - ((p3.x - p1.x) * tension) / 2;
    const cp2y = p2.y - ((p3.y - p1.y) * tension) / 2;

    pathD += ` C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }

  return pathD;
}

// ---------------------------------------------------------------------------
// 3. SVG Renderer for Light & Dark Themes
// ---------------------------------------------------------------------------

interface ThemeConfig {
  name: 'dark' | 'light';
  bgGradientStart: string;
  bgGradientMid: string;
  bgGradientEnd: string;
  cardBorder: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  gridEmpty: string;
  gridEmptyBorder: string;
  level1: string;
  level2: string;
  level3: string;
  level4: string;
  dragonBodyStart: string;
  dragonBodyMid: string;
  dragonBodyEnd: string;
  dragonWingStart: string;
  dragonWingEnd: string;
  dragonEye: string;
  fireStart: string;
  fireMid: string;
  fireEnd: string;
  glowColor: string;
}

const DARK_THEME: ThemeConfig = {
  name: 'dark',
  bgGradientStart: '#05010f',
  bgGradientMid: '#170a35',
  bgGradientEnd: '#05010f',
  cardBorder: '#2e1c66',
  textPrimary: '#00f5ff',
  textSecondary: '#c084fc',
  textMuted: '#64748b',
  gridEmpty: '#120c24',
  gridEmptyBorder: '#1c1438',
  level1: '#1f2963',
  level2: '#4338ca',
  level3: '#00f5ff',
  level4: '#ff00e5',
  dragonBodyStart: '#7c1fd6',
  dragonBodyMid: '#00f5ff',
  dragonBodyEnd: '#00f5ff',
  dragonWingStart: '#ff00e5',
  dragonWingEnd: '#00f5ff',
  dragonEye: '#ff00e5',
  fireStart: '#fff3b0',
  fireMid: '#ff8a00',
  fireEnd: '#ff00e5',
  glowColor: '#00f5ff',
};

const LIGHT_THEME: ThemeConfig = {
  name: 'light',
  bgGradientStart: '#ffffff',
  bgGradientMid: '#f5f3ff',
  bgGradientEnd: '#ffffff',
  cardBorder: '#e2e8f0',
  textPrimary: '#4338ca',
  textSecondary: '#7c3aed',
  textMuted: '#94a3b8',
  gridEmpty: '#f1f5f9',
  gridEmptyBorder: '#e2e8f0',
  level1: '#93c5fd',
  level2: '#3b82f6',
  level3: '#1d4ed8',
  level4: '#7c1fd6',
  dragonBodyStart: '#6d28d9',
  dragonBodyMid: '#2563eb',
  dragonBodyEnd: '#06b6d4',
  dragonWingStart: '#d946ef',
  dragonWingEnd: '#3b82f6',
  dragonEye: '#ec4899',
  fireStart: '#fef08a',
  fireMid: '#f97316',
  fireEnd: '#ec4899',
  glowColor: '#6366f1',
};

function renderSVG(data: UserContributionData, theme: ThemeConfig): string {
  const { weeks, totalContributions } = data.calendar;
  const numWeeks = weeks.length || 53;

  // Grid layout measurements
  const cellStep = 13;
  const cellSize = 10;
  const gridStartX = 65;
  const gridStartY = 72;
  const gridWidth = numWeeks * cellStep;
  const gridHeight = 7 * cellStep;

  const svgWidth = Math.max(900, gridStartX + gridWidth + 50);
  const svgHeight = 240;

  // Stats calculation
  let maxDayCount = 0;
  let currentStreak = 0;
  let streakCounting = true;

  // Flatten days in reverse chronological order for streak
  const allDaysReversed = weeks
    .flatMap(w => w.contributionDays)
    .sort((a, b) => b.date.localeCompare(a.date));

  for (const day of allDaysReversed) {
    if (day.contributionCount > maxDayCount) {
      maxDayCount = day.contributionCount;
    }
    if (streakCounting) {
      if (day.contributionCount > 0) {
        currentStreak++;
      } else if (currentStreak > 0) {
        streakCounting = false;
      }
    }
  }

  // Month label positions
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthLabels: { name: string; x: number }[] = [];
  let lastMonth = -1;

  weeks.forEach((w, colIdx) => {
    const firstDay = w.contributionDays[0];
    if (firstDay) {
      const d = new Date(firstDay.date);
      const m = d.getUTCMonth();
      if (m !== lastMonth) {
        monthLabels.push({
          name: monthNames[m],
          x: gridStartX + colIdx * cellStep,
        });
        lastMonth = m;
      }
    }
  });

  // Weekday labels (Mon = 1, Wed = 3, Fri = 5)
  const weekdayLabels = [
    { label: 'Mon', y: gridStartY + 1 * cellStep + 8.5 },
    { label: 'Wed', y: gridStartY + 3 * cellStep + 8.5 },
    { label: 'Fri', y: gridStartY + 5 * cellStep + 8.5 },
  ];

  // Build grid cell elements
  const cellsSvg: string[] = [];
  weeks.forEach((w, colIdx) => {
    w.contributionDays.forEach((d) => {
      const rowIdx = d.weekday;
      const x = gridStartX + colIdx * cellStep;
      const y = gridStartY + rowIdx * cellStep;

      let fill = theme.gridEmpty;
      let stroke = theme.gridEmptyBorder;
      let filterAttr = '';

      if (d.contributionLevel === 'FIRST_QUARTILE') fill = theme.level1;
      else if (d.contributionLevel === 'SECOND_QUARTILE') fill = theme.level2;
      else if (d.contributionLevel === 'THIRD_QUARTILE') {
        fill = theme.level3;
        if (theme.name === 'dark') filterAttr = 'filter="url(#cellGlow)"';
      } else if (d.contributionLevel === 'FOURTH_QUARTILE') {
        fill = theme.level4;
        filterAttr = 'filter="url(#superGlow)"';
      }

      if (d.contributionLevel !== 'NONE') {
        stroke = fill;
      }

      // Add a subtle pulse for high contribution days
      let pulseAnim = '';
      if (d.contributionLevel === 'FOURTH_QUARTILE' || d.contributionLevel === 'THIRD_QUARTILE') {
        pulseAnim = `<animate attributeName="opacity" values="0.8;1;0.8" dur="${2 + (colIdx % 3)}s" repeatCount="indefinite"/>`;
      }

      cellsSvg.push(
        `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2" ry="2" fill="${fill}" stroke="${stroke}" stroke-width="0.75" ${filterAttr}>${pulseAnim}</rect>`
      );
    });
  });

  // Build dragon flight path
  const flightPath = buildDragonPath(weeks, gridStartX, gridStartY, cellStep);

  // Background stars for dark theme
  const starsSvg: string[] = [];
  if (theme.name === 'dark') {
    const starCoords = [
      [35, 30, 1.2, 2.3], [120, 45, 1.5, 3.1], [220, 25, 1.0, 2.7], [350, 40, 1.4, 3.4],
      [480, 28, 1.1, 2.5], [600, 42, 1.3, 2.9], [720, 30, 1.5, 3.2], [840, 45, 1.2, 2.6],
      [50, 215, 1.1, 3.0], [180, 225, 1.4, 2.4], [310, 218, 1.0, 3.3], [450, 228, 1.5, 2.8],
      [580, 215, 1.2, 3.5], [710, 222, 1.3, 2.7], [850, 216, 1.4, 3.1],
    ];
    for (const [cx, cy, r, dur] of starCoords) {
      starsSvg.push(
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#ffffff"><animate attributeName="opacity" values="0.2;1;0.2" dur="${dur}s" repeatCount="indefinite"/></circle>`
      );
    }
  }

  return `<svg viewBox="0 0 ${svgWidth} ${svgHeight}" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
  <defs>
    <!-- Background Gradient -->
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${theme.bgGradientStart}"/>
      <stop offset="50%" stop-color="${theme.bgGradientMid}"/>
      <stop offset="100%" stop-color="${theme.bgGradientEnd}"/>
    </linearGradient>

    <!-- Card Border Gradient -->
    <linearGradient id="borderGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="${theme.dragonBodyStart}" stop-opacity="0.6"/>
      <stop offset="50%" stop-color="${theme.textPrimary}" stop-opacity="0.8"/>
      <stop offset="100%" stop-color="${theme.dragonWingStart}" stop-opacity="0.6"/>
    </linearGradient>

    <!-- Dragon Body Gradient -->
    <linearGradient id="bodyGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="${theme.dragonBodyStart}"/>
      <stop offset="50%" stop-color="${theme.dragonBodyMid}"/>
      <stop offset="100%" stop-color="${theme.dragonBodyEnd}"/>
    </linearGradient>

    <!-- Dragon Wing Gradient -->
    <linearGradient id="wingGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${theme.dragonWingStart}" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="${theme.dragonWingEnd}" stop-opacity="0.2"/>
    </linearGradient>

    <!-- Dragon Fire Gradient -->
    <radialGradient id="fireGrad" cx="30%" cy="50%" r="70%">
      <stop offset="0%" stop-color="${theme.fireStart}"/>
      <stop offset="35%" stop-color="${theme.fireMid}"/>
      <stop offset="100%" stop-color="${theme.fireEnd}" stop-opacity="0"/>
    </radialGradient>

    <!-- Glowing Filters -->
    <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="3" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>

    <filter id="softGlow" x="-80%" y="-80%" width="260%" height="260%">
      <feGaussianBlur stdDeviation="5" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>

    <filter id="cellGlow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="1.5" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>

    <filter id="superGlow" x="-80%" y="-80%" width="260%" height="260%">
      <feGaussianBlur stdDeviation="2.5" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>

  <style>
    .font-mono { font-family: 'Fira Code', 'SF Mono', 'Courier New', monospace; }
    .font-sans { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; }
  </style>

  <!-- Outer Card Frame -->
  <rect x="2" y="2" width="${svgWidth - 4}" height="${svgHeight - 4}" rx="14" ry="14" fill="url(#bgGrad)" stroke="url(#borderGrad)" stroke-width="1.5"/>

  <!-- Background Stars -->
  <g>${starsSvg.join('\n    ')}</g>

  <!-- Header Section -->
  <g>
    <!-- System Title -->
    <text x="24" y="34" class="font-mono" font-size="14" font-weight="700" fill="${theme.textPrimary}" ${theme.name === 'dark' ? 'filter="url(#glow)"' : ''} letter-spacing="1.5">
      SYSTEM GUARDIAN // ${data.login.toUpperCase()}
    </text>

    <!-- Subtitle / Mission Tag -->
    <text x="24" y="50" class="font-mono" font-size="10" fill="${theme.textSecondary}" letter-spacing="0.5">
      LIVE CONTRIBUTION GRID PATROL • 52-WEEK FLIGHT
    </text>

    <!-- Stats Badges (Right Aligned) -->
    <g transform="translate(${svgWidth - 310}, 20)">
      <rect x="0" y="0" width="90" height="26" rx="6" fill="${theme.name === 'dark' ? '#1c1038' : '#f1f5f9'}" stroke="${theme.cardBorder}" stroke-width="1"/>
      <text x="45" y="11" class="font-mono" font-size="7.5" fill="${theme.textMuted}" text-anchor="middle">TOTAL CONTRIBUTIONS</text>
      <text x="45" y="21" class="font-mono" font-size="10" font-weight="700" fill="${theme.textPrimary}" text-anchor="middle">${totalContributions}</text>

      <rect x="98" y="0" width="90" height="26" rx="6" fill="${theme.name === 'dark' ? '#1c1038' : '#f1f5f9'}" stroke="${theme.cardBorder}" stroke-width="1"/>
      <text x="143" y="11" class="font-mono" font-size="7.5" fill="${theme.textMuted}" text-anchor="middle">MAX IN A DAY</text>
      <text x="143" y="21" class="font-mono" font-size="10" font-weight="700" fill="${theme.textPrimary}" text-anchor="middle">${maxDayCount}</text>

      <rect x="196" y="0" width="90" height="26" rx="6" fill="${theme.name === 'dark' ? '#1c1038' : '#f1f5f9'}" stroke="${theme.cardBorder}" stroke-width="1"/>
      <text x="241" y="11" class="font-mono" font-size="7.5" fill="${theme.textMuted}" text-anchor="middle">CURRENT STREAK</text>
      <text x="241" y="21" class="font-mono" font-size="10" font-weight="700" fill="${theme.textPrimary}" text-anchor="middle">${currentStreak} days</text>
    </g>
  </g>

  <!-- Month Labels -->
  <g class="font-mono" font-size="9" fill="${theme.textMuted}">
    ${monthLabels.map(m => `<text x="${m.x}" y="${gridStartY - 8}">${m.name}</text>`).join('\n    ')}
  </g>

  <!-- Weekday Labels -->
  <g class="font-mono" font-size="8.5" fill="${theme.textMuted}" text-anchor="end">
    ${weekdayLabels.map(w => `<text x="${gridStartX - 8}" y="${w.y}">${w.label}</text>`).join('\n    ')}
  </g>

  <!-- Contribution Grid Cells -->
  <g id="grid-cells">
    ${cellsSvg.join('\n    ')}
  </g>

  <!-- Legend (Bottom Right) -->
  <g transform="translate(${svgWidth - 190}, ${gridStartY + gridHeight + 14})">
    <text x="0" y="10" class="font-mono" font-size="9" fill="${theme.textMuted}">Less</text>
    <rect x="28" y="1" width="10" height="10" rx="2" fill="${theme.gridEmpty}" stroke="${theme.gridEmptyBorder}" stroke-width="0.75"/>
    <rect x="42" y="1" width="10" height="10" rx="2" fill="${theme.level1}" stroke="${theme.level1}" stroke-width="0.75"/>
    <rect x="56" y="1" width="10" height="10" rx="2" fill="${theme.level2}" stroke="${theme.level2}" stroke-width="0.75"/>
    <rect x="70" y="1" width="10" height="10" rx="2" fill="${theme.level3}" stroke="${theme.level3}" stroke-width="0.75"/>
    <rect x="84" y="1" width="10" height="10" rx="2" fill="${theme.level4}" stroke="${theme.level4}" stroke-width="0.75"/>
    <text x="100" y="10" class="font-mono" font-size="9" fill="${theme.textMuted}">More</text>
  </g>

  <!-- Status Indicator (Bottom Left) -->
  <g transform="translate(24, ${gridStartY + gridHeight + 18})">
    <circle cx="4" cy="4" r="3.5" fill="#10b981">
      <animate attributeName="opacity" values="0.4;1;0.4" dur="1.8s" repeatCount="indefinite"/>
    </circle>
    <text x="14" y="7.5" class="font-mono" font-size="9" fill="${theme.textMuted}">
      GUARDIAN PATROL ACTIVE • ${numWeeks} WEEKS COVERAGE
    </text>
  </g>

  <!-- Roaming Cyber Dragon (Animated along Path) -->
  <g id="dragonRoam">
    <animateMotion
      dur="18s"
      repeatCount="indefinite"
      rotate="auto"
      path="${flightPath}"
    />

    <!-- Dragon Graphic (Scaled and Centered for Grid Navigation) -->
    <g transform="scale(0.18)">
      <!-- Back Wing -->
      <g id="wingBack" transform="translate(-15,5)" opacity="0.6">
        <polygon points="0,0 -55,-70 -20,-35 0,0" fill="url(#wingGrad)"/>
        <polygon points="0,0 -75,-40 -30,-15 0,0" fill="url(#wingGrad)"/>
        <animateTransform attributeName="transform" type="rotate"
          values="-8 -15 5; 34 -15 5; -8 -15 5" dur="0.65s" repeatCount="indefinite" additive="sum"/>
      </g>

      <!-- Dragon Body Spine -->
      <path d="M -140,55 Q -95,15 -50,45 T 10,10 T 65,-15 T 95,-20"
        fill="none" stroke="url(#bodyGrad)" stroke-width="15" stroke-linecap="round" filter="url(#glow)"/>

      <!-- Dorsal Spines -->
      <g fill="${theme.dragonBodyEnd}" filter="url(#glow)">
        <polygon points="-105,20 -95,-2 -85,22"/>
        <polygon points="-65,10 -55,-14 -45,12"/>
        <polygon points="-20,20 -10,-4 0,22"/>
        <polygon points="25,-2 35,-24 45,0"/>
        <polygon points="65,-22 74,-42 82,-20"/>
      </g>

      <!-- Dragon Tail -->
      <g id="tail">
        <path d="M -140,55 Q -175,50 -195,75 Q -210,92 -230,80"
          fill="none" stroke="url(#bodyGrad)" stroke-width="11" stroke-linecap="round" filter="url(#glow)"/>
        <polygon points="-230,80 -252,68 -244,88 -252,96" fill="${theme.dragonEye}" filter="url(#glow)"/>
        <animateTransform attributeName="transform" type="rotate"
          values="0 -140 55; 10 -140 55; -8 -140 55; 0 -140 55" dur="2.2s" repeatCount="indefinite"/>
      </g>

      <!-- Front Wing -->
      <g id="wingFront" transform="translate(-15,5)">
        <polygon points="0,0 60,-85 20,-45 0,0" fill="url(#wingGrad)" filter="url(#softGlow)"/>
        <polygon points="0,0 82,-52 30,-18 0,0" fill="url(#wingGrad)" filter="url(#softGlow)"/>
        <polygon points="0,0 70,-18 25,4 0,0" fill="url(#wingGrad)" opacity="0.85"/>
        <animateTransform attributeName="transform" type="rotate"
          values="6 -15 5; -38 -15 5; 6 -15 5" dur="0.65s" repeatCount="indefinite" additive="sum"/>
      </g>

      <!-- Head & Fire Breath -->
      <g id="head">
        <polygon points="80,-22 118,-34 142,-18 136,0 108,10 82,0"
          fill="url(#bodyGrad)" filter="url(#glow)"/>
        <polygon points="112,-32 120,-52 128,-30" fill="${theme.dragonBodyEnd}" filter="url(#glow)"/>
        <polygon points="98,-28 104,-46 110,-27" fill="${theme.dragonBodyEnd}" filter="url(#glow)"/>

        <!-- Glowing Eye -->
        <circle cx="118" cy="-14" r="4.2" fill="${theme.dragonEye}" filter="url(#glow)">
          <animate attributeName="r" values="3.2;5.2;3.2" dur="1.2s" repeatCount="indefinite"/>
          <animate attributeName="opacity" values="0.6;1;0.6" dur="1.2s" repeatCount="indefinite"/>
        </circle>

        <!-- Fire Breath Flickering -->
        <g id="fireBreath">
          <ellipse cx="175" cy="-10" rx="34" ry="9" fill="url(#fireGrad)">
            <animate attributeName="rx" values="20;42;24" dur="0.35s" repeatCount="indefinite"/>
            <animate attributeName="opacity" values="0.5;0.95;0.5" dur="0.35s" repeatCount="indefinite"/>
          </ellipse>
          <ellipse cx="200" cy="-8" rx="22" ry="6" fill="url(#fireGrad)">
            <animate attributeName="rx" values="12;28;14" dur="0.3s" begin="0.1s" repeatCount="indefinite"/>
            <animate attributeName="opacity" values="0.4;0.85;0.4" dur="0.3s" begin="0.1s" repeatCount="indefinite"/>
          </ellipse>
        </g>
      </g>
    </g>
  </g>
</svg>`;
}

// ---------------------------------------------------------------------------
// 4. Main Entry Point
// ---------------------------------------------------------------------------

async function main() {
  const username =
    process.argv[2] ||
    process.env.GITHUB_USER_NAME ||
    process.env.GITHUB_REPOSITORY_OWNER ||
    'granth-alpha2';

  console.log(`\n========================================`);
  console.log(`🐉 Dragon Roam Contribution Graph Generator`);
  console.log(`Target User: ${username}`);
  console.log(`========================================\n`);

  const contributionData = await getContributionData(username);

  // Ensure assets directory exists
  const assetsDir = path.resolve(process.cwd(), 'assets');
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }

  // Generate Dark SVG
  const darkSvg = renderSVG(contributionData, DARK_THEME);
  const darkPath = path.join(assetsDir, 'dragon-roam-dark.svg');
  fs.writeFileSync(darkPath, darkSvg, 'utf-8');
  console.log(`✅ Generated Dark Theme SVG: ${darkPath}`);

  // Generate Light SVG
  const lightSvg = renderSVG(contributionData, LIGHT_THEME);
  const lightPath = path.join(assetsDir, 'dragon-roam.svg');
  fs.writeFileSync(lightPath, lightSvg, 'utf-8');
  console.log(`✅ Generated Light Theme SVG: ${lightPath}`);

  console.log('\n✨ Dragon Roam contribution assets successfully generated!\n');
}

main().catch((err) => {
  console.error('Fatal error generating dragon roam contribution graphs:', err);
  process.exit(1);
});
