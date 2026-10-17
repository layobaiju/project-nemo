// Icons for map symbols and resource types: as React components for panels, and as SVG text for map markers.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Circle, Church, Construction, Eye, Flag, Flame, Hammer, Handshake, Hospital, House, Landmark, Package, Plane, PlaneLanding,
  School, Shield, Ship, StickyNote, Tent, TriangleAlert, Truck, Users, Waves, type LucideIcon,
} from 'lucide-react';

export const SYMBOL_ICONS: Record<string, LucideIcon> = {
  safe: House, embassy: Landmark, hospital: Hospital, school: School, worship: Church, shelter: Tent, checkpoint: Shield,
  roadblock: Construction, hazard: TriangleAlert, fire: Flame, flood: Waves, damage: Hammer, team: Users, vehicle: Truck,
  aircraft: Plane, landing: PlaneLanding, meeting: Handshake, observation: Eye, note: StickyNote, flag: Flag,
};
export const RESOURCE_ICONS: Record<string, LucideIcon> = { Team: Users, Vehicle: Truck, Aircraft: Plane, Boat: Ship, Equipment: Package, Other: Circle };

const svgCache = new Map<string, string>();
/** SVG markup for an icon, for map markers that live outside React. */
export function iconSvg(icon: LucideIcon | undefined, size = 15): string {
  const Icon = icon || Circle, key = `${Icon.displayName || ''}:${size}`;
  if (!svgCache.has(key)) svgCache.set(key, renderToStaticMarkup(createElement(Icon, { size, strokeWidth: 2.2 })));
  return svgCache.get(key)!;
}
