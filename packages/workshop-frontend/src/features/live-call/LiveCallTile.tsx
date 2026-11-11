import { useEffect, useRef } from 'react'
import { MicrophoneSlash } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { initials, PersonAvatar } from '../../components/PersonAvatar'
import type { CallSession, CallTile } from './callSession'

/**
 * One person's webcam in the call, or their avatar while their camera is off. The video element
 * stays mounted for the tile's life, registered with the SDK, which shows and hides the stream.
 */
export const LiveCallTile = ({
  tile,
  session,
  speaking,
  profileId,
  authenticatedApi,
}: {
  tile: CallTile
  session: CallSession
  speaking: boolean
  /** Their profile, when known, for the avatar shown while their camera is off. */
  profileId: string | null
  authenticatedApi: RpcStub<AuthenticatedApi>
}) => {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    return session.attachVideo(tile.id, video)
  }, [session, tile.id])

  const name = tile.self ? 'You' : tile.name
  const muted = !tile.audioEnabled
  const label = [name, muted && 'muted', speaking && 'speaking'].filter(Boolean).join(', ')

  return (
    <li
      aria-label={label}
      data-speaking={speaking || undefined}
      className={`relative aspect-video shrink-0 overflow-hidden rounded-xl bg-kumo-tint transition-shadow duration-150 ${
        speaking ? 'ring-2 ring-kumo-brand' : 'ring-1 ring-inset ring-kumo-line'
      }`}
    >
      {/* The SDK plays everyone's audio itself; the element only ever carries video. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={`h-full w-full object-cover ${tile.self ? '-scale-x-100' : ''} ${tile.videoEnabled ? '' : 'invisible'}`}
      />
      {!tile.videoEnabled && (
        // Centred in the space above the name, which it would otherwise meet on a narrow tile.
        <div className="absolute inset-0 grid place-items-center pb-5">
          {profileId ? (
            <PersonAvatar api={authenticatedApi} userId={profileId} name={tile.name} size={40} />
          ) : (
            <span className="grid h-10 w-10 place-items-center rounded-full bg-kumo-base text-[12px] font-semibold text-kumo-strong ring-1 ring-inset ring-kumo-line">
              {initials(tile.name)}
            </span>
          )}
        </div>
      )}
      <div className="absolute bottom-1.5 left-1.5 flex max-w-[calc(100%-12px)] items-center gap-1 rounded-md bg-kumo-base/85 px-1.5 py-0.5 backdrop-blur-sm">
        {muted && <MicrophoneSlash size={11} weight="bold" className="shrink-0 text-kumo-danger" aria-hidden="true" />}
        <span className="truncate text-[11px] leading-4 font-medium text-kumo-default">{name}</span>
      </div>
    </li>
  )
}
