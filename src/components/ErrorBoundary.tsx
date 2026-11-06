import { Component, type ReactNode } from "react";
import { tx } from "@twind/core";

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

/** 渲染出错（包括页面代码下载失败）时显示提示，不留白屏。 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error("页面渲染出错", error);
  }

  render() {
    if (!this.state.failed) {
      return this.props.children;
    }
    return (
      <div className={tx("flex items-center justify-center min-h-screen bg-canvas-parchment")}>
        <div className={tx("text-center")}>
          <div className={tx("text-4xl mb-4")}>😥</div>
          <div className={tx("text-red-600")}>页面出错了，请刷新重试</div>
          <button
            onClick={() => window.location.reload()}
            className={tx(
              "mt-4 px-6 py-2 bg-primary text-white font-semibold rounded-full",
              "hover:bg-primary-focus active:scale-95 transition-transform",
            )}
          >
            刷新页面
          </button>
        </div>
      </div>
    );
  }
}
