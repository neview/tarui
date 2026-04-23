import ServerHome from "./ServerHome"
import GitPipeline from "./GitPipeline"

export function HomePage() {
  return <ServerHome />
}

export function BookmarkPage() {
  return <GitPipeline />
}

export function PublishPage() {
  return <div className="h-full w-full bg-transparent" />
}

export function ProfilePage() {
  return <div className="h-full w-full bg-transparent" />
}

export function SettingsPage() {
  return <div className="h-full w-full bg-transparent" />
}
