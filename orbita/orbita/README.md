# Órbita — metas em sequência

https://gregkmpf.github.io/orbita/

Site de produtividade com metas diárias/semanais/mensais, calendário de atividades,
sequências (streaks) e sistema de níveis. Feito em HTML/CSS/JS puro, pronto para
GitHub Pages, com dados salvos no **Firebase** (assim funcionam em qualquer navegador,
sempre que você fizer login com sua conta).

---

## 1. Como funciona

- **Aba Metas**: cadastre metas diárias, semanais ou mensais. Cada meta tem um botão
  para marcar como concluída "hoje" (ou "esta semana" / "este mês").
- **Aba Calendário**: mostra o mês atual com uma bolinha colorida em cada dia em que
  alguma meta foi concluída. Clicar em um dia abre a lista de metas para marcar/editar
  aquele dia específico (útil para preencher um dia esquecido).
- **Sequência (streak)**: cada meta guarda quantos períodos seguidos (dias, semanas
  ou meses) foram concluídos sem interrupção, e o recorde histórico.
- **Níveis**: com base na sequência atual de cada meta:

  | Nível          | Sequência necessária |
  |----------------|-----------------------|
  | Básico ●       | 1 a 6                 |
  | Intermediário ◐| 7 a 29                |
  | Estrela ★      | 30 a 99               |
  | Ômega Ω        | 100 ou mais           |

  (Você pode alterar esses números no início do arquivo `app.js`, na constante `RANKS`.)

---

## 2. Configurar o Firebase (armazenamento na nuvem)

Isso garante que suas metas fiquem salvas e disponíveis em qualquer navegador, só
para você (protegido por login e senha).

### 2.1 Criar o projeto

1. Acesse [console.firebase.google.com](https://console.firebase.google.com) e faça
   login com sua conta Google.
2. Clique em **Adicionar projeto**, dê um nome (ex.: `orbita-metas`) e conclua a criação.
   Pode desativar o Google Analytics, não é necessário.

### 2.2 Ativar login por e-mail/senha

1. No menu lateral, vá em **Build > Authentication**.
2. Clique em **Get started**.
3. Na aba **Sign-in method**, ative o provedor **Email/Password**.

### 2.3 Criar o banco de dados (Firestore)

1. No menu lateral, vá em **Build > Firestore Database**.
2. Clique em **Create database**.
3. Escolha a localização mais próxima (ex.: `southamerica-east1`) e comece em
   **modo de produção** (production mode).

### 2.4 Configurar as regras de segurança

Ainda em Firestore Database, vá na aba **Rules** e substitua o conteúdo por:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/goals/{goalId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    match /users/{userId}/posts/{postId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    match /users/{userId}/subjects/{subjectId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    match /users/{userId}/pomodoroSessions/{sessionId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    match /users/{userId}/tasks/{taskId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

Isso garante que **cada usuário só consegue ler e escrever os próprios dados**
(metas, publicações, matérias, sessões de estudo e atividades). Clique em **Publish**.

> Sempre que adicionar uma funcionalidade nova que crie uma coleção (como
> aconteceu aqui com `subjects`, `pomodoroSessions` e `tasks`), volte em
> **Firestore Database > Rules** e cole a versão atualizada, senão a nova
> funcionalidade falha com erro de permissão.

### 2.5 Pegar as chaves de configuração

1. Clique na engrenagem ⚙️ ao lado de "Project Overview" > **Project settings**.
2. Na aba **General**, role até "Your apps" e clique no ícone `</>` (Web) para
   registrar um app web. Dê um apelido, não precisa marcar Firebase Hosting.
3. O Firebase vai mostrar um bloco `const firebaseConfig = { ... }`. Copie esses
   valores.
4. Abra o arquivo **`firebase-config.js`** deste projeto e cole os valores no lugar
   de `COLE_AQUI_SUA_API_KEY`, `SEU_PROJETO`, etc.

### 2.6 Criar a sua conta

Depois de publicar o site (passo 3), abra-o e use o link **"Ainda não tenho conta —
criar agora"** na tela de login para criar seu usuário com e-mail e senha. Como as
regras do passo 2.4 restringem cada conta aos próprios dados, não tem problema esse
cadastro ficar acessível publicamente — só quem souber seu e-mail e senha acessa suas
metas.

---

## 3. Publicar no GitHub Pages

1. Crie um repositório novo no GitHub (ex.: `orbita`).
2. Envie todos os arquivos desta pasta (`index.html`, `style.css`, `app.js`,
   `firebase-config.js`, `README.md`) para a raiz do repositório.
3. No repositório, vá em **Settings > Pages**.
4. Em "Build and deployment", selecione **Deploy from a branch**, escolha a branch
   `main` e a pasta `/ (root)`. Salve.
5. Em alguns minutos o GitHub mostra o link do seu site (algo como
   `https://seu-usuario.github.io/orbita/`).

### Importante sobre domínios autorizados

Se o login der erro de domínio não autorizado, volte no Firebase em
**Authentication > Settings > Authorized domains** e adicione o domínio do seu
GitHub Pages (ex.: `seu-usuario.github.io`).

---

## 4. Rodando localmente (opcional, para testar antes de publicar)

Não dá para abrir `index.html` direto clicando duas vezes (o navegador bloqueia
alguns recursos). Rode um servidor simples, por exemplo com Python:

```
python3 -m http.server 8000
```

Depois acesse `http://localhost:8000` no navegador. Lembre de adicionar `localhost`
na lista de domínios autorizados do Firebase (geralmente já vem liberado por padrão).

---

## 5. Estrutura dos arquivos

```
index.html          → estrutura da página (login, abas, modais)
style.css            → identidade visual (tema "espaço/constelação")
app.js               → toda a lógica: autenticação, sequências, calendário
firebase-config.js   → suas chaves do Firebase (edite este arquivo)
```

Os dados ficam salvos no Firestore em:
`users/{seu-uid}/goals/{id-da-meta}` — cada meta guarda nome, tipo, cor e a lista de
datas em que foi concluída.
`users/{seu-uid}/posts/{id-da-publicação}` — cada publicação guarda título,
conteúdo, tags e data de criação.
`users/{seu-uid}/subjects/{id-da-matéria}` — cada matéria de estudo guarda nome e cor.
`users/{seu-uid}/pomodoroSessions/{id-da-sessão}` — cada sessão guarda a matéria,
os minutos estudados e a data.

---

## 6. Publicações (mini-blog)

Na aba **Metas**, logo abaixo das colunas de metas, existe a seção **Publicações**.
Ali você pode escrever textos livres (estudos, anotações, o que quiser), marcar tags
como `código` ou `trabalho` (ou criar tags novas digitando e pressionando Enter) e
publicar. Cada publicação ocupa a largura total da área de conteúdo, uma embaixo da
outra, e dá para filtrar a lista clicando em uma tag no topo da seção.

---

## 7. Pomodoro

Na aba **Pomodoro**, você registra o tempo estudado por matéria:

1. Clique em **"+ gerenciar matérias"** para cadastrar as matérias que você estuda
   (ex.: Inglês, Cálculo, React), cada uma com uma cor.
2. Selecione a matéria clicando no chip dela, escolha a duração do foco (15, 25, 45
   ou 60 min) e clique em **Iniciar**.
3. Quando o cronômetro de foco chega a zero, o tempo é registrado automaticamente
   para aquela matéria naquele dia, e o app entra em modo pausa. Se você pular a
   fase de foco antes de terminar, o tempo decorrido (se maior que 1 minuto) também
   é registrado.
4. A seção **"Hoje"** mostra o total do dia e o total geral; **"Hoje por matéria"**
   mostra a divisão do dia; e **"Histórico"** lista todas as sessões agrupadas por
   dia, com opção de excluir um registro individual (útil se você errou a matéria
   ou quer limpar um teste).
