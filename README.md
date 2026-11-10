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

로그인 교환 응답에는 갱신 토큰이나 만료 시간이 없습니다. 발급받은 계정 키를 사용하며, 키가 폐기되면 `/login`으로 다시 로그인해야 합니다.

## 지원 범위

- 공개 모델 카탈로그에서 모델 ID, 입력 형식, 컨텍스트 크기, 출력 한도를 가져옵니다. 초기 모델은 앱에 내장된 `glm-5.3-flash`입니다.
- 추론 단계는 OMP의 검토된 모델별 규칙을 사용합니다. GPT-6 계열에는 `xhigh`와 `max`, GLM·DeepSeek·Kimi 계열에는 `max`가 표시됩니다. 모델별 규칙이 없는 모델은 DeepAI 앱의 기존 `minimal / low / medium / high` 범위를 유지합니다. 저장된 모델 캐시에도 같은 규칙을 적용하므로 캐시 만료를 기다릴 필요는 없습니다. 실행 중인 OMP는 재시작해야 새 익스텐션을 읽습니다.
- 스트리밍, 도구 호출과 결과 재전송, 이미지 입력, 추론 내용, 토큰 사용량은 OMP의 OpenAI 전송 구현을 사용합니다.
- 모델 카탈로그가 `openai-responses`를 지정하면 Responses API를 사용하고, 나머지는 Chat Completions API를 사용합니다.
- 데스크톱 앱 0.3.20과 같은 lane 4 헤더를 전송합니다. macOS에서는 실제 IOPlatformUUID의 SHA-256 다이제스트를 머신 식별 헤더로 사용합니다. 다른 OS의 머신 식별은 구현하지 않았으므로 머신 인증이 필요한 모델은 제한될 수 있습니다.
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
- 사용자가 제공한 DeepAI Code 0.3.20 ARM64 앱의 JavaScript 번들에서 현재 로그인 경로와 lane 4 헤더를 확인했습니다.

`nka551774-hue/deepai2api`의 웹 채팅 `tryit` 인증 경로는 사용하지 않습니다.
