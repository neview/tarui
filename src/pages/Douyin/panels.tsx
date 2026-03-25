import { Home, Bookmark, CirclePlus, UserRound, Settings, Heart, MessageCircle, Share2, Play } from "lucide-react";

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-2xl p-4 ${className}`}
      style={{
        background: "rgba(255,255,255,0.05)",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      {children}
    </div>
  );
}

export function HomePage() {
  return (
    <div className="h-full p-5 overflow-y-auto pb-24">
      <div className="flex items-center gap-2 mb-5">
        <Home size={20} className="text-white" />
        <h2 className="text-white text-lg font-semibold">首页</h2>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {["热门推荐", "最新发布", "关注动态", "附近的人"].map((title, i) => (
          <Card key={i} className="aspect-[4/3] flex flex-col justify-between">
            <div className="flex items-center gap-2">
              <Play size={14} className="text-white/50" />
              <span className="text-white/60 text-xs">12.{i + 1}k 播放</span>
            </div>
            <span className="text-white/80 text-sm font-medium">{title}</span>
          </Card>
        ))}
      </div>
      <Card className="mt-3">
        <div className="flex items-center justify-between">
          <span className="text-white/70 text-sm">今日热榜</span>
          <span className="text-white/30 text-xs">查看更多 →</span>
        </div>
        <div className="mt-3 space-y-3">
          {["#热门话题挑战", "#创意短视频", "#日常生活记录"].map((tag, i) => (
            <div key={i} className="flex items-center gap-3">
              <span className="text-white/20 text-xs font-bold w-4">{i + 1}</span>
              <span className="text-white/60 text-sm">{tag}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

export function BookmarkPage() {
  return (
    <div className="h-full p-5 overflow-y-auto pb-24">
      <div className="flex items-center gap-2 mb-5">
        <Bookmark size={20} className="text-white" />
        <h2 className="text-white text-lg font-semibold">收藏</h2>
      </div>
      <div className="space-y-3">
        {["设计灵感合集", "编程教程", "美食探店", "旅行日记", "音乐推荐"].map((title, i) => (
          <Card key={i} className="flex items-center gap-4">
            <div
              className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: `rgba(255,255,255,${0.04 + i * 0.02})` }}
            >
              <Heart size={16} className="text-white/40" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-white/80 text-sm font-medium truncate">{title}</p>
              <p className="text-white/30 text-xs mt-1">{3 + i * 2} 个内容</p>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function PublishPage() {
  return (
    <div className="h-full p-5 overflow-y-auto pb-24">
      <div className="flex items-center gap-2 mb-5">
        <CirclePlus size={20} className="text-white" />
        <h2 className="text-white text-lg font-semibold">发布</h2>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {[
          { icon: Play, label: "拍摄视频", desc: "录制短视频" },
          { icon: Share2, label: "上传视频", desc: "从相册选择" },
          { icon: MessageCircle, label: "发布图文", desc: "图片+文字" },
          { icon: Heart, label: "开直播", desc: "实时互动" },
        ].map((item, i) => {
          const Icon = item.icon;
          return (
            <Card key={i} className="flex flex-col items-center py-6 gap-3">
              <div
                className="w-12 h-12 rounded-full flex items-center justify-center"
                style={{ background: "rgba(255,255,255,0.08)" }}
              >
                <Icon size={20} className="text-white/60" />
              </div>
              <div className="text-center">
                <p className="text-white/80 text-sm font-medium">{item.label}</p>
                <p className="text-white/30 text-xs mt-1">{item.desc}</p>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

export function ProfilePage() {
  return (
    <div className="h-full p-5 overflow-y-auto pb-24">
      <div className="flex items-center gap-2 mb-5">
        <UserRound size={20} className="text-white" />
        <h2 className="text-white text-lg font-semibold">我的</h2>
      </div>
      <Card className="flex items-center gap-4 mb-4">
        <div
          className="w-14 h-14 rounded-full flex items-center justify-center shrink-0"
          style={{ background: "rgba(255,255,255,0.1)" }}
        >
          <UserRound size={24} className="text-white/50" />
        </div>
        <div>
          <p className="text-white/90 text-base font-semibold">用户名</p>
          <p className="text-white/30 text-xs mt-1">抖音号: 88888888</p>
        </div>
      </Card>
      <div className="grid grid-cols-3 gap-3 mb-4">
        {[
          { num: "128", label: "关注" },
          { num: "2.1k", label: "粉丝" },
          { num: "5.6k", label: "获赞" },
        ].map((stat) => (
          <Card key={stat.label} className="text-center py-3">
            <p className="text-white/90 text-base font-bold">{stat.num}</p>
            <p className="text-white/30 text-xs mt-1">{stat.label}</p>
          </Card>
        ))}
      </div>
      <Card>
        <p className="text-white/30 text-xs leading-relaxed">
          这里是个人简介，记录美好生活的每一天 ✨
        </p>
      </Card>
    </div>
  );
}

export function SettingsPage() {
  return (
    <div className="h-full p-5 overflow-y-auto pb-24">
      <div className="flex items-center gap-2 mb-5">
        <Settings size={20} className="text-white" />
        <h2 className="text-white text-lg font-semibold">设置</h2>
      </div>
      <div className="space-y-2">
        {[
          "账号与安全",
          "隐私设置",
          "通知设置",
          "通用设置",
          "存储空间",
          "关于我们",
        ].map((item) => (
          <Card key={item} className="flex items-center justify-between py-3">
            <span className="text-white/70 text-sm">{item}</span>
            <span className="text-white/20 text-sm">›</span>
          </Card>
        ))}
      </div>
    </div>
  );
}
