# DeepAI Code for OMP

DeepAI Code 데스크톱 앱의 브라우저 로그인과 모델 API를 OMP에 연결하는 익스텐션입니다. 별도 게이트웨이 서버 없이 `https://api.deepai.org/deepai_code`에 직접 연결합니다.

## 설치

Bun, pnpm, OMP 18.18.1 이상이 필요합니다.

```sh
pnpm install
ln -s "$PWD" ~/.omp/agent/extensions/deepai-code
```

이미 심볼릭 링크가 있으면 다시 만들 필요가 없습니다. 실행 중인 OMP는 재시작하세요. 설치하지 않고 한 번 실행하려면 `omp -e ./index.ts`를 사용합니다.

## 로그인과 모델 선택

OMP에서 `/login`을 실행하고 **DeepAI Code**를 선택하세요. 브라우저에서 DeepAI 로그인을 완료하면 `127.0.0.1` 콜백을 통해 일회용 코드를 교환하고, 계정 키를 OMP의 인증 저장소에 보관합니다. 비밀번호는 익스텐션에서 받거나 저장하지 않습니다.

이후 `/model`에서 `deepai-code/` 모델을 선택합니다. 로그인한 모델 목록은 다음 명령으로도 확인할 수 있습니다.

```sh
omp models deepai-code
```

### 남은 Theo 확인

OMP의 기존 `/usage`에서 DeepAI Code 계정의 남은 Theo, 지급량, 다음 갱신 시각을
확인할 수 있습니다. 기존 `/login` 인증과 네이티브 사용량 표시를 사용하며 별도 명령이나
모델 호출은 추가하지 않습니다. 잔액 조회가 거부되거나 제공되지 않으면 0이 아닌
`unavailable`로 표시합니다. 잔액 조회 실패를 모델 사용 불가로 처리하지 않습니다.

터미널에서는 `omp usage --provider deepai-code`로 같은 정보를 확인할 수 있습니다.

로그인 교환 응답에는 갱신 토큰이나 만료 시간이 없습니다. 발급받은 계정 키를 사용하며, 키가 폐기되면 `/login`으로 다시 로그인해야 합니다.

## 지원 범위

- 로그인 키로 인증한 모델 카탈로그에서 모델 ID, 입력 형식, 컨텍스트 크기, 출력 한도를 가져옵니다. 초기 모델은 앱에 내장된 `glm-5.3-flash`입니다.
- 추론 단계는 원 제공사의 공식 모델별 지원 범위를 사용합니다. Claude·GPT-6·MiniMax M3.1 Flash는 `low / medium / high / xhigh / max`, GLM 5.3·DeepSeek V4.1 Flash·Kimi K3는 `low / high / max`, Qwen 3.8은 `low / medium / xhigh`를 제공합니다. Gemini 4 Argon·Carbon은 3단계이고 Hydrogen은 `xhigh`를 추가로 제공합니다. Muse Ember·Wonder·Spark 1.3은 `minimal`부터 `max`까지 6단계입니다.
- MiMo 2.6 Flash·Pro는 [Xiaomi 공식 Codex 카탈로그](https://mimo.mi.com/docs/en-US/tokenplan/integration/codex-configuration)대로 `Off(none) / low / medium / high`를 제공하며 기본값은 `low`입니다. DeepAI의 Chat 요청에는 `reasoning_effort`, Responses 요청에는 `reasoning.effort`로 전달합니다. `minimal`은 `low`로, 별도 메뉴가 아닌 호환 입력 `xhigh / max`는 `high`로 정규화합니다. [MiMo Responses 문서](https://mimo.mi.com/static/docs/api/chat/responses-post.md)에 따르면 현재 `none` 이외의 값은 추론을 켜며, 실제 강도는 구분되지 않습니다.
- MiniMax M3는 강도 조절 없이 켜기/끄기만 지원합니다. OMP에서는 `high`가 켜기에 해당하며, 요청에는 `reasoning_effort` 대신 공식 `thinking.type`을 보냅니다. 필수 추론 모델에는 Off를 제공하지 않고 강제 Off 요청도 최저 지원 단계로 처리합니다. Solar의 기존 `minimal` 요청은 공식 의미대로 추론 끄기로 전송합니다.
- 공식 effort 목록이 없는 DeepAI Cyber·Glyph Cluster와 미등록 모델에는 단계를 임의로 만들지 않습니다. 추론 내용은 유지하되 effort 제어 필드를 보내지 않아 서버 기본 동작을 사용합니다. 저장된 모델 캐시에도 같은 규칙을 적용하므로 캐시 만료를 기다릴 필요는 없습니다. 실행 중인 OMP는 재시작해야 새 익스텐션을 읽습니다.
- 스트리밍, 도구 호출과 결과 재전송, 이미지 입력, 추론 내용, 토큰 사용량은 OMP의 OpenAI 전송 구현을 사용합니다.
- 모델 카탈로그가 `openai-responses`를 지정하면 Responses API를 사용하고, 나머지는 Chat Completions API를 사용합니다.
- 데스크톱 앱 0.3.37의 lane 6 규약을 사용합니다. 계정별 체크인을 호출 전에 확인하고 유효기간의 절반이 지나면 갱신합니다. 체크인에는 이 익스텐션의 실제 이름과 버전을 표시하며 앱의 포커스 상태를 가장하지 않습니다. macOS에서는 실제 IOPlatformUUID의 SHA-256 다이제스트를 머신 식별 헤더로 사용합니다. 다른 OS의 머신 식별은 구현하지 않았으므로 머신 인증이 필요한 모델은 제한될 수 있습니다.
- 세션 식별자를 캐시 키와 affinity 헤더에 함께 전달하고, 이미지가 없는 일반 텍스트 사용자 입력만 문자열로 정규화합니다. `409/session_busy`는 서버의 대기 시간에 따라 취소 가능한 상태로 재시도하며, 다른 오류를 임의로 재전송하지 않습니다.
- 모델별 무료/유료 여부와 Theos 차감은 DeepAI가 결정합니다. 카탈로그의 달러 단위 토큰 비용은 0으로 표시하므로 OMP의 달러 비용 표시를 DeepAI 청구 금액으로 해석하면 안 됩니다.

## 개발 검사

```sh
pnpm run check
pnpm test
pnpm run lint
pnpm exec oxfmt --check
```

로컬 테스트는 모델별 추론 단계와 캐시 보정, OAuth state 거부와 코드 교환, 인증 헤더가 필요한 도구 호출 스트림, Responses 모델 라우팅과 사용량 처리, 추론 끄기의 `none` 인코딩, 동시 요청 제한 시 스트림 종료 대기를 검사합니다. 실제 계정 로그인 및 원격 모델 가용성은 로컬 테스트와 별도로 확인해야 합니다.

## 참고

- [lavabyte/deepai-gateway](https://github.com/lavabyte/deepai-gateway): DeepAI Code의 로그인, 모델 API 및 전송 규약을 참고했습니다.
- 설치된 DeepAI Code 0.3.37 ARM64 앱을 CANY CLI로 분석해 모델 인증, lane 6 체크인과 LLM 전송 규약을 확인했습니다.

`nka551774-hue/deepai2api`의 웹 채팅 `tryit` 인증 경로는 사용하지 않습니다.
