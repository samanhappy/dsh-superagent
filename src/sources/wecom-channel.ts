/** WeCom outbound Channel: markdown replies over the bot's long connection, with the images a reply attaches. */
import { closeSync, openSync, readSync, statSync, type Stats } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import type { OutboundMessage } from '../core/index.ts'
import { checkedImText } from '../infra/text.ts'
import { wecomImageType } from './wecom-image.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink } from './kind.ts'
import { activeWecom, WecomAckError } from './wecom-ws.ts'

/** WeCom accepts at most 20480 bytes of markdown per message. */
export const WECOM_MARKDOWN_MAX_BYTES = 20_480
/** WeCom's image limit, and how many of them one reply may carry: more belongs in a file or a link. */
export const WECOM_IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const WECOM_IMAGES_MAX = 4
/**
 * WeCom error codes that mean the conversation can never accept this message, so the Outbox stops instead of retrying.
 * Every other code is retried: guessing wrong here would drop a reply a person waits for.
 */
const goneCodes = new Set([86003])
/** Truncates markdown to WeCom's byte limit, keeping the ellipsis inside it. */
export function truncateWecom(text: string): string {
  if (Buffer.byteLength(text) <= WECOM_MARKDOWN_MAX_BYTES) return text
  let kept = ''
  for (const character of text) {
    if (Buffer.byteLength(kept + character) > WECOM_MARKDOWN_MAX_BYTES - 3) break
    kept += character
  }
  return `${kept}…`
}
/** A WeCom markdown message body, the form both replies and proactive sends use. */
export const wecomMarkdown = (text: string): Record<string, unknown> => ({ msgtype: 'markdown', markdown: { content: truncateWecom(text) } })
/**
 * Refuses a reply WeCom can never send, at queue time and again at delivery: the text over the word limit, or an image
 * that is not a readable image file. Reading the file here is what lets a queued message fail while its writer is still
 * listening, rather than retrying a message whose file a worker later deleted.
 */
export function checkWecom(message: OutboundMessage): void {
  checkedImText(message.text)
  const images = message.images ?? []
  if (images.length > WECOM_IMAGES_MAX) throw new Error(`A WeCom reply carries at most ${WECOM_IMAGES_MAX} images; send the rest as a file or a link`)
  for (const path of images) {
    if (!isAbsolute(path)) throw new Error(`An image path must be absolute: ${path}`)
    let stat: Stats
    try { stat = statSync(path) } catch { throw new Error(`The image file cannot be read: ${path}`) }
    if (!stat.isFile()) throw new Error(`The image path is not a file: ${path}`)
    if (stat.size === 0) throw new Error(`The image file is empty: ${path}`)
    if (stat.size > WECOM_IMAGE_MAX_BYTES) throw new Error(`The image file is over ${WECOM_IMAGE_MAX_BYTES} bytes: ${path}`)
    const header = Buffer.alloc(12)
    let fd: number | undefined
    try { fd = openSync(path, 'r'); readSync(fd, header, 0, header.length, 0) } finally { if (fd !== undefined) closeSync(fd) }
    if (!wecomImageType(header)) throw new Error(`The file is not a PNG, JPEG, WebP or GIF image: ${path}`)
  }
}
/**
 * Replies into the conversation of the addressed message. WeCom sends by conversation rather than by message: the reply is
 * a new message in the same chat, which is also why it can be produced minutes after the Trigger arrived. Images are
 * uploaded first and the text is sent before them, so a failed upload leaves the conversation untouched and image
 * messages name `media_id`s that already exist.
 */
export async function sendWecom(_host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const chatId = message.channel.address.chatId
  if (!chatId) throw new Error('Missing WeCom reply target')
  const connection = activeWecom()
  if (!connection || !connection.isAuthenticated) throw new Error('The WeCom long connection is not open; the reply is retried later')
  checkWecom(message)
  const text = truncateWecom(checkedImText(message.text))
  try {
    const media: string[] = []
    for (const path of message.images ?? []) media.push(await connection.uploadImage(await readFile(path), basename(path)))
    await connection.send(chatId, wecomMarkdown(text))
    for (const mediaId of media) await connection.send(chatId, { msgtype: 'image', image: { media_id: mediaId } })
  } catch (error) {
    if (error instanceof WecomAckError && goneCodes.has(error.code)) return 'gone'
    throw error
  }
  return 'sent'
}
/** WeCom has no public link that opens a conversation, so the panel shows the message source without one. */
export const wecomLink = (): ChannelLink => ({ url: '', label: { zh: '企业微信', en: 'WeCom' } })
