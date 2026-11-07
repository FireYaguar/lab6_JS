import { z } from 'zod'
import { asEntityId, asSeq, asTick } from '../brand.ts'

// ЄДИНЕ джерело правди про повідомлення: схема Zod → тип TypeScript (z.infer) → перевірка в рантаймі.
// Типи стираються під час збірки, тож усе, що прийшло з мережі, — unknown, доки не пройде схему.

export const PROTOCOL_VERSION = 1
export const LIMITS = { name: 16, room: 32, text: 200 }

const u32 = z.number().int().min(0).max(0xffffffff)
export const SeqSchema = u32.transform(asSeq)
export const TickSchema = u32.transform(asTick)
export const EntityIdSchema = u32.transform(asEntityId)
export const TurnSchema = z.union([z.literal(-1), z.literal(0), z.literal(1)])
export const EffectSchema = z.enum(['shield', 'rapid', 'homing'])
const v = z.literal(PROTOCOL_VERSION)

// ---------- клієнт → сервер ----------
export const JoinMessage = z.object({
  v,
  type: z.literal('join'),
  room: z.string().trim().min(1).max(LIMITS.room),
  name: z.string().trim().min(1).max(LIMITS.name),
})
export const ChatMessage = z.object({
  v,
  type: z.literal('chat'),
  text: z.string().trim().min(1).max(LIMITS.text),
})
export const LeaveMessage = z.object({ v, type: z.literal('leave') })
export const InputMessage = z.object({
  v,
  type: z.literal('input'),
  seq: SeqSchema,
  thrust: z.boolean(),
  turn: TurnSchema,
  fire: z.boolean(),
})
export const PingMessage = z.object({ v, type: z.literal('ping'), t: z.number() })
export const NetsimMessage = z.object({
  v,
  type: z.literal('netsim'),
  lag: z.number().min(0).max(1000),
  jitter: z.number().min(0).max(500),
  drop: z.number().min(0).max(0.5),
})
export const ClientMessage = z.discriminatedUnion('type', [
  JoinMessage,
  ChatMessage,
  LeaveMessage,
  InputMessage,
  PingMessage,
  NetsimMessage,
])
export type ClientMessage = z.infer<typeof ClientMessage>
export type InputMessage = z.infer<typeof InputMessage>

// ---------- знімок світу ----------
const base = { id: EntityIdSchema, x: z.number(), y: z.number() }
export const ShipState = z.object({
  ...base,
  kind: z.literal('ship'),
  angle: z.number(),
  vx: z.number(),
  vy: z.number(),
  hp: z.number().int().min(0).max(255),
  solid: z.boolean(),
  thrust: z.boolean(),
  cooldown: z.number().min(0),
  shield: z.number().min(0),
  rapid: z.number().min(0),
  homingShots: z.number().min(0),
  respawnIn: z.number(),
  score: u32,
})
export const BulletState = z.object({
  ...base,
  kind: z.literal('bullet'),
  homing: z.boolean(),
  ownerId: EntityIdSchema,
  seq: SeqSchema,
})
export const AsteroidState = z.object({
  ...base,
  kind: z.literal('asteroid'),
  angle: z.number(),
  radius: z.number().min(0).max(255),
  shape: z.number().int().min(0).max(2),
  homing: z.boolean(),
})
export const PickupState = z.object({ ...base, kind: z.literal('pickup'), effect: EffectSchema })
export const ExplosionState = z.object({ ...base, kind: z.literal('explosion') })
export const EntityState = z.discriminatedUnion('kind', [
  ShipState,
  BulletState,
  AsteroidState,
  PickupState,
  ExplosionState,
])
export type ShipState = z.infer<typeof ShipState>
export type BulletState = z.infer<typeof BulletState>
export type EntityState = z.infer<typeof EntityState>

export const SnapshotMessage = z.object({
  type: z.literal('snapshot'),
  tick: TickSchema,
  ack: SeqSchema,
  entities: z.array(EntityState),
})
export type Snapshot = z.infer<typeof SnapshotMessage>

// ---------- сервер → клієнт ----------
export const ArenaInfo = z.object({
  width: z.number().int().min(600).max(4000),
  height: z.number().int().min(400).max(3000),
  asteroids: z.number().int().min(0).max(40),
  seed: z
    .number()
    .int()
    .min(0)
    .max(2 ** 31 - 1),
})
export const RoomInfo = z.object({
  id: z.string(),
  name: z.string(),
  players: z.number().int(),
  maxPlayers: z.number().int(),
  arena: ArenaInfo,
})
export type RoomInfo = z.infer<typeof RoomInfo>

const player = z.object({ id: z.string(), name: z.string() })
export const ServerMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('welcome'), playerId: z.string(), room: RoomInfo }),
  z.object({
    type: z.literal('match'),
    shipId: EntityIdSchema,
    tickRate: z.number(),
    arena: ArenaInfo,
  }),
  z.object({
    type: z.literal('roster'),
    players: z.array(player.extend({ shipId: EntityIdSchema.optional() })),
  }),
  z.object({ type: z.literal('chat'), from: player, text: z.string(), t: z.number() }),
  z.object({ type: z.literal('system'), text: z.string() }),
  z.object({ type: z.literal('pong'), t: z.number() }),
  z.object({ type: z.literal('shutdown') }),
  SnapshotMessage, // лише з ?codec=json; за замовчуванням знімок — бінарний кадр
])
export type ServerMessage = z.infer<typeof ServerMessage>

// Лобі: GET /api/rooms
export const RoomsResponse = z.object({ version: z.literal(1), rooms: z.array(RoomInfo) })
