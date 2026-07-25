import ServerHome from "./ServerHome"
import SplashCursor from "./SplashCursor"

export default function Douyin() {
  return (
    <div className="relative h-full w-full overflow-hidden bg-gray-50 dark:bg-[#050510]">
      <SplashCursor />

      <div className="absolute inset-0 z-10">
        <ServerHome />
      </div>
    </div>
  )
}
